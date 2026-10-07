// Fake NovelAI backend for demo mode and tests. Streams plausible text so the whole UI can be exercised offline.
import type { Fetcher } from './nai';
import { MARK_EN2KO, MARK_GLOSSARY, MARK_KO2EN, MARK_TAGS } from './prompts';

export interface MockOptions {
  /** Delay between streamed tokens. */
  delayMs?: number;
}

const EN_POOL = [
  'The rain had not stopped for three days, and the old lighthouse groaned with every gust.',
  'Elise pressed her palm against the cold glass and watched the harbor lights flicker out one by one.',
  '"You came back," she said, without turning around.',
  'Kael stood in the doorway, his coat still dripping, a letter sealed with black wax in his hand.',
  '"I told you I would," he replied. "I just didn\'t say when."',
  'Somewhere below, the sea struck the rocks like a slow, patient drum.',
  'She finally faced him, and for a moment neither of them knew what to do with the silence.',
];

const KO_POOL = [
  '사흘째 비가 그치지 않았고, 낡은 등대는 바람이 불 때마다 신음했다.',
  '엘리제는 차가운 유리창에 손바닥을 대고 항구의 불빛이 하나둘 꺼지는 것을 지켜보았다.',
  '"돌아왔네." 그녀는 돌아보지도 않은 채 말했다.',
  '카엘은 물이 뚝뚝 떨어지는 외투 차림으로 문간에 서 있었다. 손에는 검은 밀랍으로 봉한 편지가 들려 있었다.',
  '"온다고 했잖아." 그가 대답했다. "언제라고는 말 안 했을 뿐이지."',
  '저 아래 어딘가에서 파도가 느리고 끈질긴 북소리처럼 바위를 때렸다.',
  '마침내 그녀가 그를 마주 보았고, 잠시 둘 다 그 침묵을 어떻게 해야 할지 몰랐다.',
];

const TAGS_SOLO = { base: '1girl, solo, upper body, indoors, lighthouse, window, night, rain, dim lighting, long hair, silver hair, white dress, looking outside, sad', characters: [] };
const TAGS_DUO = {
  base: '1girl, 1boy, cowboy shot, indoors, lighthouse, doorway, night, rain, candlelight',
  characters: [
    { name: '엘리제', prompt: 'girl, long hair, silver hair, white dress, surprised, looking at another', position: 'left' },
    { name: '카엘', prompt: 'boy, black hair, wet hair, long coat, holding letter, standing', position: 'right' },
  ],
};

export function createMockFetcher(opts: MockOptions = {}): Fetcher {
  const delay = opts.delayMs ?? 25;
  let turn = 0;

  return async (url, init) => {
    await wait(delay * 4, init.signal ?? undefined);
    const path = new URL(url).pathname;

    if (path === '/oa/v1/models') {
      return json({ object: 'list', data: ['glm-4-6', 'xialong-v1', 'llama-3-erato-v1', 'kayra-v1'].map((id) => ({ id, object: 'model' })) });
    }
    if (path === '/user/subscription') {
      return json({
        tier: 3,
        active: true,
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 20,
        perks: { contextTokens: 8192 },
        trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 0 },
      });
    }

    const body = JSON.parse(String(init.body ?? '{}'));

    if (path === '/oa/v1/chat/completions') {
      const system: string = body.messages?.[0]?.content ?? '';
      const last: string = body.messages?.at(-1)?.content ?? '';
      let text: string;
      if (system.startsWith(MARK_EN2KO)) text = fakeTranslate(last, KO_POOL);
      else if (system.startsWith(MARK_KO2EN)) text = fakeTranslate(last, EN_POOL);
      else if (system.startsWith(MARK_TAGS)) text = JSON.stringify(/Kael|카엘|두 사람|둘/.test(last) ? TAGS_DUO : TAGS_SOLO);
      else if (system.startsWith(MARK_GLOSSARY))
        text = JSON.stringify([
          { en: 'Elise', ko: '엘리제', note: '반말, 차분함' },
          { en: 'Kael', ko: '카엘', note: '반말, 무뚝뚝함' },
        ]);
      else {
        const korean = /in Korean/.test(system);
        text = pick(korean ? KO_POOL : EN_POOL, turn++, 3).join(korean ? ' ' : ' ');
      }
      return sse(
        tokens(text).map((t) => JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })).concat('[DONE]'),
        delay,
        init.signal ?? undefined,
      );
    }

    if (path === '/ai/generate-stream') {
      const text = ' ' + pick(EN_POOL, turn++, 2).join(' ');
      const toks = tokens(text);
      return sse(
        toks.map((t, i) => JSON.stringify({ token: t, ptr: i, final: i === toks.length - 1 })),
        delay,
        init.signal ?? undefined,
        'newToken',
      );
    }

    if (path === '/ai/generate-image') {
      const p = body.parameters ?? {};
      const svg = demoSvg(p.width ?? 832, p.height ?? 1216, String(body.input ?? ''));
      await wait(delay * 40, init.signal ?? undefined);
      return json({ images: [{ index: 0, seed: p.seed ?? 0, image: toBase64(new TextEncoder().encode(svg)) }] }, 201);
    }

    return json({ statusCode: 404, message: 'mock: unknown endpoint' }, 404);
  };
}

function fakeTranslate(src: string, pool: string[]): string {
  // One output paragraph per input paragraph, so layout checks behave like the real thing.
  return src
    .split(/(\n+)/)
    .map((part, i) => (/^\n+$/.test(part) || !part.trim() ? part : pool[(i / 2 + part.length) % pool.length]))
    .join('');
}

function pick(pool: string[], seed: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => pool[(seed * n + i) % pool.length]);
}

function tokens(text: string): string[] {
  return text.match(/\s*\S{1,6}/g) ?? [text];
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
}

function sse(datas: string[], delay: number, signal?: AbortSignal, event?: string): Response {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (signal?.aborted) {
        ctrl.error(new DOMException('aborted', 'AbortError'));
        return;
      }
      if (i >= datas.length) {
        ctrl.close();
        return;
      }
      await wait(delay);
      const head = event ? `event: ${event}\nid: ${i}\n` : '';
      ctrl.enqueue(enc.encode(`${head}data: ${datas[i++]}\n\n`));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function demoSvg(w: number, h: number, prompt: string): string {
  const hue = [...prompt].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const words = prompt.split(',').slice(0, 6).map((s) => s.trim().replace(/[<&>]/g, ''));
  const lines = words.map((t, i) => `<text x="50%" y="${42 + i * 4}%" font-size="${Math.round(w / 24)}" text-anchor="middle" fill="#fff" opacity="0.85">${t}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,20%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="50%" y="30%" font-size="${Math.round(w / 12)}" text-anchor="middle" fill="#fff" font-weight="bold">DEMO</text>${lines}</svg>`;
}
