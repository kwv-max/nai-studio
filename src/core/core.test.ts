import { describe, expect, it } from 'vitest';
import { createMockFetcher } from './mock';
import { DEFAULT_SETTINGS } from './models';
import { holdBackPartialStop, NaiClient, type Fetcher } from './nai';
import { chatCompletionPrompt, MARK_EN2KO, MARK_KO2EN, novelCompletionPrompt } from './prompts';
import { readSse } from './sse';
import { joinSeparator, Studio } from './studio';
import { translate } from './translate';
import type { Settings } from './types';
import { chunkByParagraph, mirrorEdgeWhitespace, stripThinking, tailChars } from './util';
import { unzip } from './zip';

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, apiKey: 'pst-test', ...over });

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

interface Call {
  url: string;
  init: RequestInit;
  body: any;
}

/** Records requests; `respond` decides each response. */
function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const call = { url, init, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetcher };
}

function chatSse(...pieces: string[]): Response {
  const lines = pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  return new Response(streamOf(...lines, 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
}

describe('sse', () => {
  it('parses events split across chunks with CRLF and multi-line data', async () => {
    const events = [];
    for await (const e of readSse(streamOf('event: newTo', 'ken\r\ndata: {"a":', '1}\r\n\r\n: keep-alive\n\ndata: x\ndata: y\n\n'))) events.push(e);
    expect(events).toEqual([
      { event: 'newToken', data: '{"a":1}' },
      { event: 'message', data: 'x\ny' },
    ]);
  });
});

describe('util', () => {
  it('strips closed and still-open reasoning blocks', () => {
    expect(stripThinking('<think>plan</think>Hello')).toBe('Hello');
    expect(stripThinking('Hi <think>partial')).toBe('Hi ');
  });

  it('mirrors edge whitespace so segments join the same way in both languages', () => {
    expect(mirrorEdgeWhitespace('\n\nShe ran. ', '그녀는 달렸다.')).toBe('\n\n그녀는 달렸다. ');
    expect(mirrorEdgeWhitespace(' and left.', '  떠났다.\n')).toBe(' 떠났다.');
  });

  it('chunks at paragraph boundaries and keeps every character', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(10)).join('\n\n');
    const chunks = chunkByParagraph(text, 500);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
  });

  it('cuts the context tail at a paragraph boundary', () => {
    const text = 'a'.repeat(100) + '\nSecond paragraph here.';
    expect(tailChars(text, 30)).toBe('Second paragraph here.');
  });
});

describe('joinSeparator', () => {
  it('starts a new paragraph after a finished sentence', () => {
    expect(joinSeparator('She left.', 'The door closed.')).toBe('\n\n');
    expect(joinSeparator('그녀는 떠났다.', '문이 닫혔다.')).toBe('\n\n');
  });
  it('continues a sentence with a space', () => {
    expect(joinSeparator('She walked toward the', 'door and knocked.')).toBe(' ');
  });
  it('adds nothing when the story is empty or the text brings its own whitespace', () => {
    expect(joinSeparator('', 'Once upon a time.')).toBe('');
    expect(joinSeparator('End.', '\nNext')).toBe('');
  });
});

describe('prompts', () => {
  it('puts memory, the author\'s note near the end and the instruction in braces', () => {
    const { input, instruct } = novelCompletionPrompt({
      systemPrompt: 'A dark fantasy.',
      authorsNote: 'Tense mood',
      instruction: 'Kael reveals the letter',
      storyTail: 'L1\nL2\nL3\nL4\nL5',
    });
    expect(instruct).toBe(true);
    expect(input).toBe('A dark fantasy.\n***\nL1\nL2\n[ Tense mood ]\nL3\nL4\nL5\n{ Kael reveals the letter }\n');
  });

  it('builds a script for completion models and stops at the next speaker', () => {
    const { input, stopAt } = chatCompletionPrompt({
      systemPrompt: '',
      charName: 'Elise',
      userName: 'Kael',
      history: [
        { role: 'user', text: 'Hello.' },
        { role: 'assistant', text: 'Hi.' },
      ],
    });
    expect(input).toBe('Kael: Hello.\nElise: Hi.\nElise:');
    expect(stopAt).toContain('\nKael:');
  });
});

describe('NaiClient', () => {
  it('streams chat completions with auth, stream:true and thinking off', async () => {
    const { calls, fetcher } = recorder(() => chatSse('<think>x</think>Hel', 'lo'));
    const seen: string[] = [];
    const out = await new NaiClient('pst-abc', fetcher).chat({
      model: 'glm-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      params: { temperature: 0.8, topP: 0.95, topK: 0, minP: 0, maxTokens: 100 },
      onText: (t) => seen.push(t),
    });
    expect(out).toBe('Hello');
    expect(seen.at(-1)).toBe('Hello');
    expect(calls[0].url).toBe('https://text.novelai.net/oa/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer pst-abc');
    expect(calls[0].body).toMatchObject({ model: 'glm-4-6', stream: true, enable_thinking: false, max_tokens: 100 });
    expect(calls[0].body.top_k).toBeUndefined();
  });

  it('adds the Erato prefix and cuts completions at a stop string', async () => {
    const toks = [' Hi', ' there.', '\nKa', 'el:', ' more'];
    const body = toks.map((t, i) => `event: newToken\ndata: ${JSON.stringify({ token: t, ptr: i, final: false })}\n\n`);
    const { calls, fetcher } = recorder(() => new Response(streamOf(...body), { headers: { 'content-type': 'text/event-stream' } }));
    const out = await new NaiClient('k', fetcher).complete({
      model: 'llama-3-erato-v1',
      input: 'Elise:',
      params: { temperature: 1.37, topP: 1, topK: 0, minP: 0.035, maxTokens: 150 },
      stopAt: ['\nKael:'],
    });
    expect(out).toBe(' Hi there.');
    expect(calls[0].url).toBe('https://text.novelai.net/ai/generate-stream');
    expect(calls[0].body.input).toBe('<|startoftext|><|reserved_special_token81|>Elise:');
    expect(calls[0].body.parameters).toMatchObject({ use_string: true, max_length: 150, prefix: 'vanilla' });
  });

  it('hides a trailing partial stop string while streaming', () => {
    expect(holdBackPartialStop('Hello\nKa', ['\nKael:'])).toBe('Hello');
    expect(holdBackPartialStop('Hello', ['\nKael:'])).toBe('Hello');
  });

  it('maps HTTP errors to Korean messages', async () => {
    const { fetcher } = recorder(() => new Response(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }), { status: 401 }));
    await expect(new NaiClient('bad', fetcher).getAccount()).rejects.toThrow(/API 키가 올바르지 않아요/);
  });

  it('requires a key before any request', async () => {
    await expect(new NaiClient('', async () => new Response('')).listModels()).rejects.toThrow(/API 키를 먼저/);
  });

  it('reads JSON image responses and sends v4 prompt fields', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const b64 = btoa(String.fromCharCode(...png));
    const { calls, fetcher } = recorder(() => Response.json({ images: [{ image: b64, seed: 42, index: 0 }] }, { status: 201 }));
    const r = await new NaiClient('k', fetcher).image({
      prompt: '1girl, rain',
      negativePrompt: 'lowres',
      settings: { ...DEFAULT_SETTINGS.image, seed: 7 },
    });
    expect(r.mime).toBe('image/png');
    expect(r.seed).toBe(42);
    expect(calls[0].body.input).toBe('1girl, rain, very aesthetic, masterpiece, no text');
    expect(calls[0].body.parameters.v4_prompt.caption.base_caption).toBe(calls[0].body.input);
    expect(calls[0].body.parameters.seed).toBe(7);
    expect((calls[0].init.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('falls back to unzipping a zip image response', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const zip = storedZip('image_0.png', png);
    const { fetcher } = recorder(() => new Response(zip, { headers: { 'content-type': 'application/x-zip-compressed' } }));
    const r = await new NaiClient('k', fetcher).image({ prompt: 'x', negativePrompt: '', settings: DEFAULT_SETTINGS.image });
    expect([...r.bytes]).toEqual([...png]);
  });
});

describe('translate', () => {
  it('sends glossary and prior pairs, keeps edge whitespace', async () => {
    const { calls, fetcher } = recorder(() => chatSse('그녀는 ', '웃었다.'));
    const s = settings();
    const out = await translate({
      client: new NaiClient('k', fetcher),
      settings: s,
      direction: 'en2ko',
      text: '\n\nShe smiled.',
      glossary: [{ id: '1', en: 'Elise', ko: '엘리제', note: '반말' }],
      context: [{ src: 'Hello.', dst: '안녕.' }],
    });
    expect(out).toBe('\n\n그녀는 웃었다.');
    const msgs = calls[0].body.messages;
    expect(msgs[0].content.startsWith(MARK_EN2KO)).toBe(true);
    expect(msgs[0].content).toContain('Elise → 엘리제 (반말)');
    expect(msgs.slice(1).map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(calls[0].body.model).toBe('glm-4-6');
    expect(calls[0].body.temperature).toBe(0.3);
  });
});

describe('Studio pipeline (mock backend)', () => {
  const fast = createMockFetcher({ delayMs: 0 });

  it('novel: generates English, then translates to Korean, reporting phases', async () => {
    const studio = new Studio(settings(), fast);
    const phases: string[] = [];
    const story = await studio.continueStory(
      { id: 's', title: 't', createdAt: 0, updatedAt: 0, systemPrompt: '어두운 판타지', authorsNote: '', glossary: [], segments: [] },
      { onProgress: (p) => phases.push(p.phase) },
    );
    const seg = story.segments[0];
    expect(seg.en).toMatch(/[a-z]/);
    expect(seg.ko).toMatch(/[가-힣]/);
    expect([...new Set(phases)]).toEqual(['preparing', 'generating', 'translating', 'done']);
    // Korean system prompt was translated once and cached on the story.
    expect(Object.keys(story.cache ?? {})).toHaveLength(1);
  });

  it('novel with Erato: direct-ko falls back to translate', async () => {
    const studio = new Studio(settings({ outputMode: 'direct-ko', textModel: 'llama-3-erato-v1' }), fast);
    expect(studio.effectiveMode('llama-3-erato-v1')).toBe('translate');
    const story = await studio.continueStory({ id: 's', title: 't', createdAt: 0, updatedAt: 0, systemPrompt: '', authorsNote: '', glossary: [], segments: [] });
    expect(story.segments[0].en).toMatch(/[a-z]/);
    expect(story.segments[0].ko).toMatch(/[가-힣]/);
  });

  it('chat: Korean input is translated for the model, reply translated back', async () => {
    const { calls, fetcher } = recorder((c) => {
      const sys: string = c.body.messages[0].content;
      if (sys.startsWith(MARK_KO2EN)) return chatSse('Where were you?');
      if (sys.startsWith(MARK_EN2KO)) return chatSse('어디 갔다 왔어?');
      return chatSse('I was at the harbor.');
    });
    const studio = new Studio(settings(), fetcher);
    let userSeen = false;
    const chat = await studio.sendChat(
      { id: 'c', title: 't', createdAt: 0, updatedAt: 0, systemPrompt: '', charName: 'Elise', userName: 'Kael', glossary: [], messages: [] },
      '어디 있었어?',
      { onUserMessage: (c) => (userSeen = c.messages.length === 1) },
    );
    expect(userSeen).toBe(true);
    expect(chat.messages.map((m) => [m.role, m.en, m.ko])).toEqual([
      ['user', 'Where were you?', '어디 있었어?'],
      ['assistant', 'I was at the harbor.', '어디 갔다 왔어?'],
    ]);
    const gen = calls.find((c) => c.body.messages[0].content.includes('You are Elise'))!;
    expect(gen.body.messages.at(-1)).toEqual({ role: 'user', content: 'Where were you?' });
    expect(gen.body.messages[0].content).toContain('Always reply in English.');
  });

  it('chat: direct-ko skips translation entirely', async () => {
    const { calls, fetcher } = recorder(() => chatSse('항구에 있었어.'));
    const studio = new Studio(settings({ outputMode: 'direct-ko' }), fetcher);
    const chat = await studio.sendChat(
      { id: 'c', title: 't', createdAt: 0, updatedAt: 0, systemPrompt: '너는 엘리제야.', charName: '엘리제', userName: '카엘', glossary: [], messages: [] },
      '어디 있었어?',
    );
    expect(calls).toHaveLength(1);
    expect(chat.messages[1]).toMatchObject({ en: '', ko: '항구에 있었어.' });
    expect(calls[0].body.messages[0].content).toContain('Always reply in Korean.');
  });

  it('images: Korean description becomes tags before generating', async () => {
    const studio = new Studio(settings(), fast);
    const img = await studio.generateImage({ prompt: '비 오는 밤 등대 안의 은발 소녀' });
    expect(img.prompt).toMatch(/1girl/);
    expect(img.sourceKo).toBe('비 오는 밤 등대 안의 은발 소녀');
    expect(img.mime).toBe('image/svg+xml');
  });

  it('glossary suggestions skip existing entries', async () => {
    const studio = new Studio(settings(), fast);
    const got = await studio.suggestGlossary('Elise and Kael.', [{ id: 'x', en: 'Elise', ko: '엘리제' }]);
    expect(got.map((g) => g.en)).toEqual(['Kael']);
  });

  it('abort stops generation with an AbortError', async () => {
    const studio = new Studio(settings({ mock: true }));
    const ctrl = new AbortController();
    const p = studio.continueStory(
      { id: 's', title: 't', createdAt: 0, updatedAt: 0, systemPrompt: '', authorsNote: '', glossary: [], segments: [] },
      { signal: ctrl.signal },
    );
    setTimeout(() => ctrl.abort(), 30);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/** Builds a single-entry stored (uncompressed) zip. */
function storedZip(name: string, data: Uint8Array): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, nameBytes.length, true);
  const cen = new DataView(new ArrayBuffer(46));
  cen.setUint32(0, 0x02014b50, true);
  cen.setUint32(20, data.length, true);
  cen.setUint32(24, data.length, true);
  cen.setUint16(28, nameBytes.length, true);
  cen.setUint32(42, 0, true);
  const cenOffset = 30 + nameBytes.length + data.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, 1, true);
  eocd.setUint16(10, 1, true);
  eocd.setUint32(12, 46 + nameBytes.length, true);
  eocd.setUint32(16, cenOffset, true);
  const parts = [new Uint8Array(local.buffer), nameBytes, data, new Uint8Array(cen.buffer), nameBytes, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
}

describe('zip', () => {
  it('reads stored entries', async () => {
    const entries = await unzip(storedZip('a.png', Uint8Array.from([1, 2, 3])));
    expect(entries[0].name).toBe('a.png');
    expect([...entries[0].data]).toEqual([1, 2, 3]);
  });
});
