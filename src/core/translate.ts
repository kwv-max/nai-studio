import { genParamsFor } from './models';
import type { NaiClient } from './nai';
import { translatorMessages, type Direction, type Pair } from './prompts';
import type { GlossaryEntry, Settings } from './types';
import { chunkByParagraph, cleanModelText, mirrorEdgeWhitespace, throwIfAborted } from './util';

const CHUNK_CHARS = 3000;
const CONTEXT_CHARS = 2500;

export interface TranslateOptions {
  client: NaiClient;
  settings: Settings;
  direction: Direction;
  text: string;
  glossary: GlossaryEntry[];
  /** Earlier translations in the same direction, oldest first. */
  context?: Pair[];
  signal?: AbortSignal;
  /** Called with the full translation so far. */
  onText?: (text: string) => void;
}

/** Translates with the translator model, chunk by chunk, keeping paragraph layout and edge whitespace. */
export async function translate(o: TranslateOptions): Promise<string> {
  if (!o.text.trim()) return o.text;
  const model = o.settings.translatorModel;
  const base = genParamsFor(o.settings, model);

  const chunks = chunkByParagraph(o.text, CHUNK_CHARS);
  const done: string[] = [];
  let context = fitContext(o.context ?? []);

  for (const chunk of chunks) {
    throwIfAborted(o.signal);
    if (!chunk.trim()) {
      done.push(chunk);
      continue;
    }
    const ratio = o.direction === 'en2ko' ? 1 : 2;
    const params = { ...base, temperature: 0.3, topP: 0.9, topK: 0, minP: 0, maxTokens: Math.min(4096, 256 + Math.ceil(chunk.length * ratio)) };
    const prefix = done.join('');
    const out = await o.client.chat({
      model,
      messages: translatorMessages(o.direction, chunk, o.glossary, o.settings.translationStyle, context),
      params,
      signal: o.signal,
      onText: (t) => o.onText?.(prefix + mirrorEdgeWhitespace(chunk, tidy(t))),
    });
    const translated = mirrorEdgeWhitespace(chunk, tidy(out));
    done.push(translated);
    context = fitContext([...context, { src: chunk, dst: translated }]);
  }

  const result = mirrorEdgeWhitespace(o.text, done.join(''));
  o.onText?.(result);
  return result;
}

/** Keeps the most recent pairs within the context budget. */
function fitContext(pairs: Pair[]): Pair[] {
  const out: Pair[] = [];
  let total = 0;
  for (let i = pairs.length - 1; i >= 0 && out.length < 3; i--) {
    const p = pairs[i];
    if (!p.src.trim() || !p.dst.trim()) continue;
    const size = p.src.length + p.dst.length;
    if (total + size > CONTEXT_CHARS) break;
    total += size;
    out.unshift(p);
  }
  return out;
}

function tidy(s: string): string {
  return cleanModelText(s).replace(/^\s*(번역|translation|korean|english)\s*[:：]\s*/i, '');
}
