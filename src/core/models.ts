import type { GenParams, ImageSettings, ModelKind, Settings, TextModelInfo } from './types';

export const TEXT_API = 'https://text.novelai.net';
export const IMAGE_API = 'https://image.novelai.net';

export const DEFAULT_TRANSLATOR = 'glm-4-6';

/** Models we know how to talk to. Anything else returned by /oa/v1/models is treated as a chat model. */
export const KNOWN_TEXT_MODELS: TextModelInfo[] = [
  { id: 'glm-4-6', label: 'GLM-4.6', kind: 'chat', note: '지시를 잘 따르는 대화형 모델. 번역도 이 모델이 맡아요.', maxOutputTokens: 4096 },
  { id: 'xialong-v1', label: 'Xialong', kind: 'chat', note: 'GLM-4.6 기반 창작 특화 모델 (Opus 전용)', maxOutputTokens: 4096 },
  { id: 'llama-3-erato-v1', label: 'Erato', kind: 'completion', note: '영어 소설 이어쓰기 특화. 문장력이 좋아요.', maxOutputTokens: 150 },
  { id: 'kayra-v1', label: 'Kayra', kind: 'completion', note: '구형 영어 이어쓰기 모델', maxOutputTokens: 150 },
];

/** Models served only by the legacy api.novelai.net host, which this app doesn't use. */
const UNSUPPORTED = /clio|krake|euterpe|sigurd|genji|snek|hypebot|infillmodel/i;

export function modelKind(id: string): ModelKind {
  return /erato|kayra/i.test(id) ? 'completion' : 'chat';
}

export function modelInfo(id: string): TextModelInfo {
  return (
    KNOWN_TEXT_MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      kind: modelKind(id),
      note: '',
      maxOutputTokens: modelKind(id) === 'completion' ? 150 : 4096,
    }
  );
}

/** Known models first, then any extra ids the account can see. */
export function mergeModelList(listedIds: string[]): TextModelInfo[] {
  const extra = listedIds
    .filter((id) => !UNSUPPORTED.test(id) && !KNOWN_TEXT_MODELS.some((m) => m.id === id))
    .map(modelInfo);
  return [...KNOWN_TEXT_MODELS, ...extra];
}

const CHAT_DEFAULTS: GenParams = { temperature: 0.8, topP: 0.95, topK: 0, minP: 0, maxTokens: 800 };
const ERATO_DEFAULTS: GenParams = { temperature: 1.37, topP: 1, topK: 0, minP: 0.035, maxTokens: 150 };
const KAYRA_DEFAULTS: GenParams = { temperature: 1.35, topP: 0.85, topK: 15, minP: 0, maxTokens: 150 };

export function defaultGenParams(model: string): GenParams {
  if (/erato/i.test(model)) return { ...ERATO_DEFAULTS };
  if (/kayra/i.test(model)) return { ...KAYRA_DEFAULTS };
  return { ...CHAT_DEFAULTS };
}

/** Defaults merged with the user's overrides, clamped to what the API accepts. */
export function genParamsFor(settings: Settings, model: string): GenParams {
  const p = { ...defaultGenParams(model), ...(settings.genByModel[model] ?? {}) };
  const info = modelInfo(model);
  p.maxTokens = Math.max(1, Math.min(p.maxTokens, info.maxOutputTokens));
  // Chat models lack NovelAI's exotic samplers; high temperatures produce garbage.
  if (info.kind === 'chat') p.temperature = Math.min(p.temperature, 1.25);
  return p;
}

/**
 * Sampler settings for /ai/generate-stream that the UI doesn't expose.
 * Values match NovelAI's default presets for each model.
 */
export function completionPreset(model: string): Record<string, unknown> {
  if (/erato/i.test(model)) {
    return {
      top_a: 0.1,
      typical_p: 0.875,
      tail_free_sampling: 0.87,
      repetition_penalty: 3.25,
      repetition_penalty_range: 6000,
      repetition_penalty_slope: 3.25,
      repetition_penalty_frequency: 0,
      repetition_penalty_presence: 0,
      phrase_rep_pen: 'off',
      mirostat_lr: 0.2,
      mirostat_tau: 4,
      math1_temp: 0.9,
      math1_quad: 0.07,
      math1_quad_entropy_scale: -0.05,
      order: [0, 5, 9, 10, 8, 4],
    };
  }
  return {
    top_a: 0.1,
    tail_free_sampling: 0.915,
    repetition_penalty: 2.8,
    repetition_penalty_range: 2048,
    repetition_penalty_slope: 0.02,
    repetition_penalty_frequency: 0.02,
    repetition_penalty_presence: 0,
    phrase_rep_pen: 'aggressive',
    order: [2, 3, 0, 4, 1],
  };
}

/** Text Erato expects before the prompt. */
export function completionPrefix(model: string): string {
  return /erato/i.test(model) ? '<|startoftext|><|reserved_special_token81|>' : '';
}

/** How many characters of history to send. */
export function contextBudgetChars(settings: Settings, model: string): number {
  if (settings.contextChars > 0) return settings.contextChars;
  const info = modelInfo(model);
  if (info.kind === 'completion') {
    const tokens = settings.account?.contextTokens ?? 4096;
    const params = genParamsFor(settings, model);
    // ~3.5 chars per token for English with these tokenizers, minus room for output and memory.
    return Math.max(2000, Math.floor((tokens - params.maxTokens - 300) * 3.5));
  }
  return 24000;
}

// ---------------------------------------------------------------- images

export interface ImageModelInfo {
  id: string;
  label: string;
  /** V4+ models take the structured v4_prompt fields. */
  v4: boolean;
  qualityTags: string;
  defaultNegative: string;
}

const V45_NEG =
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const V4_NEG =
  'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks';
const V3_NEG =
  'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]';

export const IMAGE_MODELS: ImageModelInfo[] = [
  { id: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 Full', v4: true, qualityTags: 'very aesthetic, masterpiece, no text', defaultNegative: V45_NEG },
  { id: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion V4.5 Curated', v4: true, qualityTags: 'very aesthetic, masterpiece, no text', defaultNegative: V45_NEG },
  { id: 'nai-diffusion-4-full', label: 'NAI Diffusion V4 Full', v4: true, qualityTags: 'no text, best quality, very aesthetic, absurdres', defaultNegative: V4_NEG },
  { id: 'nai-diffusion-3', label: 'NAI Diffusion Anime V3', v4: false, qualityTags: 'best quality, amazing quality, very aesthetic, absurdres', defaultNegative: V3_NEG },
];

export function imageModelInfo(id: string): ImageModelInfo {
  return (
    IMAGE_MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      v4: !/diffusion-[123]\b|diffusion$|furry|safe-diffusion/.test(id),
      qualityTags: '',
      defaultNegative: V45_NEG,
    }
  );
}

export const IMAGE_SIZES = [
  { label: '세로', width: 832, height: 1216 },
  { label: '가로', width: 1216, height: 832 },
  { label: '정사각형', width: 1024, height: 1024 },
] as const;

export const IMAGE_SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde'];

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  negativePrompt: V45_NEG,
  qualityTags: true,
  seed: -1,
};

/** Opus subscribers generate for free at ≤1MP, ≤28 steps, one image. */
export function isFreeForOpus(settings: Settings): boolean {
  const i = settings.image;
  return settings.account?.tier === 3 && i.width * i.height <= 1024 * 1024 && i.steps <= 28;
}

export const TIER_NAMES = ['Paper (체험)', 'Tablet', 'Scroll', 'Opus'];

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  rememberKey: true,
  textModel: 'glm-4-6',
  translatorModel: DEFAULT_TRANSLATOR,
  outputMode: 'translate',
  translationStyle: '',
  contextChars: 0,
  genByModel: {},
  image: DEFAULT_IMAGE_SETTINGS,
  mock: false,
  account: null,
};
