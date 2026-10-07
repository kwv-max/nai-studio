import { errorFromResponse, NaiError } from './errors';
import { completionPrefix, completionPreset, IMAGE_API, imageModelInfo, positionToCenter, TEXT_API, TIER_NAMES } from './models';
import { readSse } from './sse';
import type { AccountInfo, CharacterPrompt, GenParams, ImageSettings } from './types';
import { base64ToBytes, sniffImageMime, stripThinking } from './util';
import { unzip } from './zip';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatTurn[];
  params: GenParams;
  /** GLM reasoning mode. Off by default: slower and not useful for prose or translation. */
  thinking?: boolean;
  signal?: AbortSignal;
  /** Called with the full visible text so far (reasoning stripped). */
  onText?: (text: string) => void;
}

export interface CompletionRequest {
  model: string;
  /** Prompt text without the model's special prefix (added here). */
  input: string;
  params: GenParams;
  /** Enables Erato/Kayra instruct mode for `{ ... }` instructions in the prompt. */
  instruct?: boolean;
  /** Generation stops (client-side) at the first occurrence of any of these. */
  stopAt?: string[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

export interface ImageRequest {
  /** Base prompt (scene). Quality tags are appended here when enabled. */
  prompt: string;
  /** Per-character prompts. Merged into the base prompt for models without character prompts. */
  characters?: CharacterPrompt[];
  negativePrompt: string;
  settings: ImageSettings;
  signal?: AbortSignal;
}

export interface ImageResult {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  seed: number;
}

/** Thin wrapper over the NovelAI generation APIs. All requests go straight from the browser (CORS is open). */
export class NaiClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  private async send(url: string, init: RequestInit): Promise<Response> {
    if (!this.apiKey) throw new NaiError('API 키를 먼저 입력해 주세요.');
    let res: Response;
    try {
      res = await this.fetcher(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) },
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new NaiError('NovelAI에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.', null, String(e));
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.send(`${TEXT_API}/oa/v1/models`, { method: 'GET', signal });
    const j = await res.json();
    return Array.isArray(j?.data) ? j.data.map((m: { id: string }) => m.id).filter(Boolean) : [];
  }

  async getAccount(signal?: AbortSignal): Promise<AccountInfo> {
    const res = await this.send(`${IMAGE_API}/user/subscription`, { method: 'GET', signal });
    const j = await res.json();
    const tier = Number(j?.tier ?? 0);
    const steps = j?.trainingStepsLeft ?? {};
    return {
      tier,
      tierName: TIER_NAMES[tier] ?? `Tier ${tier}`,
      active: Boolean(j?.active),
      expiresAt: j?.expiresAt ? Number(j.expiresAt) * 1000 : null,
      anlas: Number(steps.fixedTrainingStepsLeft ?? 0) + Number(steps.purchasedTrainingSteps ?? 0),
      contextTokens: j?.perks?.contextTokens ? Number(j.perks.contextTokens) : null,
    };
  }

  /** Chat models (GLM etc.). Always streams: NovelAI leaves `content` empty on non-streamed responses. */
  async chat(req: ChatRequest): Promise<string> {
    const p = req.params;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      max_tokens: p.maxTokens,
      temperature: p.temperature,
      top_p: p.topP,
      enable_thinking: Boolean(req.thinking),
    };
    if (p.topK > 0) body.top_k = p.topK;
    if (p.minP > 0) body.min_p = p.minP;

    const res = await this.send(`${TEXT_API}/oa/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.headers.get('content-type')?.includes('event-stream') || !res.body) {
      const j = await res.json();
      const text = stripThinking(String(j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? ''));
      req.onText?.(text);
      return text;
    }

    let raw = '';
    for await (const ev of readSse(res.body, req.signal)) {
      if (ev.data === '[DONE]') break;
      let j: any;
      try {
        j = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (j?.error || ev.event === 'error') {
        const msg = String(j?.error?.message ?? j?.error ?? j?.message ?? ev.data);
        throw new NaiError(`생성 중 오류가 났어요: ${msg}`, null, msg);
      }
      const choice = j?.choices?.[0];
      const piece = choice?.delta?.content ?? choice?.text ?? '';
      if (piece) {
        raw += piece;
        req.onText?.(stripThinking(raw));
      }
    }
    return stripThinking(raw);
  }

  /** Completion models (Erato, Kayra) via the native streaming endpoint. */
  async complete(req: CompletionRequest): Promise<string> {
    const p = req.params;
    const body = {
      input: completionPrefix(req.model) + req.input,
      model: req.model,
      parameters: {
        use_string: true,
        temperature: p.temperature,
        max_length: p.maxTokens,
        min_length: 1,
        top_k: p.topK,
        top_p: p.topP,
        min_p: p.minP,
        ...completionPreset(req.model),
        generate_until_sentence: true,
        use_cache: false,
        return_full_text: false,
        prefix: req.instruct ? 'special_instruct' : 'vanilla',
      },
    };

    // Our own controller so we can hang up once a stop string appears.
    const inner = new AbortController();
    const onOuterAbort = () => inner.abort();
    req.signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const res = await this.send(`${TEXT_API}/ai/generate-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: inner.signal,
      });
      if (!res.body) throw new NaiError('응답이 비어 있어요.');

      const stops = req.stopAt?.filter(Boolean) ?? [];
      let text = '';
      let stopped = false;
      for await (const ev of readSse(res.body, inner.signal)) {
        let j: any;
        try {
          j = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (j?.error || ev.event === 'error' || (j?.statusCode && j?.message)) {
          const msg = String(j?.error ?? j?.message ?? ev.data);
          throw new NaiError(`생성 중 오류가 났어요: ${msg}`, j?.statusCode ?? null, msg);
        }
        if (typeof j?.token === 'string') text += j.token;

        const cut = firstStop(text, stops);
        if (cut >= 0) {
          text = text.slice(0, cut);
          stopped = true;
        }
        req.onText?.(stopped ? text : holdBackPartialStop(text, stops));
        if (stopped || j?.final) break;
      }
      if (stopped) inner.abort();
      return text;
    } catch (e) {
      if (req.signal?.aborted) throw new DOMException('사용자가 중단했어요.', 'AbortError');
      throw e;
    } finally {
      req.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  async image(req: ImageRequest): Promise<ImageResult> {
    const s = req.settings;
    const info = imageModelInfo(s.model);
    const seed = s.seed >= 0 ? s.seed : Math.floor(Math.random() * 4294967295);

    const allChars = (req.characters ?? []).filter((ch) => ch.prompt.trim());
    const chars = allChars.slice(0, info.maxCharacters);
    let base = joinTags([req.prompt, ...allChars.slice(info.maxCharacters).map((ch) => ch.prompt)]);
    const transparent = s.transparent && info.transparency;
    if (transparent && !/transparent background/i.test(base)) base = joinTags([base, 'transparent background']);
    const prompt = s.qualityTags && info.qualityTags ? joinTags([base, info.qualityTags]) : base;

    // Positions apply only if the user placed at least one character; otherwise the model chooses.
    const useCoords = chars.some((ch) => ch.position && ch.position !== 'auto');
    const centers = chars.map((ch) => positionToCenter(useCoords ? ch.position : 'auto'));

    const parameters: Record<string, unknown> = {
      params_version: 4,
      width: s.width,
      height: s.height,
      scale: s.scale,
      sampler: s.sampler,
      steps: s.steps,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: s.qualityTags,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: true,
      cfg_rescale: s.cfgRescale,
      // NovelAI's client always uses karras on V5.
      noise_schedule: info.family === 'v5' ? 'karras' : s.noiseSchedule,
      legacy_v3_extend: false,
      seed,
      negative_prompt: req.negativePrompt,
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
    };
    if (info.family === 'v3') {
      parameters.sm = false;
      parameters.sm_dyn = false;
    } else {
      parameters.use_coords = useCoords;
      parameters.legacy_uc = false;
      parameters.v4_prompt = {
        caption: { base_caption: prompt, char_captions: chars.map((ch, i) => ({ char_caption: ch.prompt.trim(), centers: [centers[i]] })) },
        use_coords: useCoords,
        use_order: true,
      };
      parameters.v4_negative_prompt = {
        caption: { base_caption: req.negativePrompt, char_captions: chars.map((_, i) => ({ char_caption: '', centers: [centers[i]] })) },
        legacy_uc: false,
      };
      parameters.characterPrompts = chars.map((ch, i) => ({ prompt: ch.prompt.trim(), uc: '', center: centers[i], enabled: true }));
      if (transparent) parameters.tag_hint_transparent_background = true;
    }

    const res = await this.send(`${IMAGE_API}/ai/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ input: prompt, model: s.model, action: 'generate', parameters }),
      signal: req.signal,
    });

    const type = res.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      const j = await res.json();
      const first = j?.images?.[0];
      if (!first?.image) throw new NaiError('이미지가 응답에 없어요.');
      const bytes = base64ToBytes(first.image);
      return { bytes, mime: sniffImageMime(bytes), seed: Number(first.seed ?? seed) };
    }

    const entries = await unzip(await res.arrayBuffer());
    const img = entries.find((e) => /\.(png|webp|jpe?g)$/i.test(e.name)) ?? entries[0];
    if (!img) throw new NaiError('이미지가 응답에 없어요.');
    return { bytes: img.data, mime: sniffImageMime(img.data), seed };
  }
}

/** Joins comma-separated tag lists, dropping empty pieces and stray commas. */
function joinTags(parts: string[]): string {
  return parts.map((p) => p.trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
}

function firstStop(text: string, stops: string[]): number {
  let best = -1;
  for (const s of stops) {
    const i = text.indexOf(s);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/** Hides a trailing fragment that could be the start of a stop string, so it never flashes on screen. */
export function holdBackPartialStop(text: string, stops: string[]): string {
  let cut = text.length;
  for (const s of stops) {
    for (let k = Math.min(s.length - 1, text.length); k > 0; k--) {
      if (text.endsWith(s.slice(0, k))) {
        cut = Math.min(cut, text.length - k);
        break;
      }
    }
  }
  return text.slice(0, cut);
}
