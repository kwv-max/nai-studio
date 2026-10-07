// High-level operations the UI calls. Each one takes a document and returns an updated copy;
// nothing here mutates its inputs or touches storage. Persist the returned document yourself.
import { NaiError } from './errors';
import { createMockFetcher } from './mock';
import { contextBudgetChars, genParamsFor, mergeModelList, modelInfo, KNOWN_TEXT_MODELS } from './models';
import { NaiClient, type Fetcher } from './nai';
import {
  chatCompletionPrompt,
  chatMessages,
  glossaryMessages,
  novelChatMessages,
  novelCompletionPrompt,
  tagMessages,
  type ChatLine,
  type Direction,
  type Pair,
} from './prompts';
import { translate } from './translate';
import type {
  AccountInfo,
  Chat,
  ChatMessage,
  GalleryImage,
  GlossaryEntry,
  OutputMode,
  Phase,
  RunOptions,
  Segment,
  Settings,
  Story,
  TextModelInfo,
} from './types';
import { cleanModelText, hash, hasHangul, mirrorEdgeWhitespace, tailChars, uid } from './util';

interface Bilingual {
  id: string;
  en: string;
  ko: string;
}

export interface EditInput {
  /** New Korean text. Re-translated to English unless writing directly in Korean. */
  ko?: string;
  /** New English text. Re-translated to Korean in translate mode. */
  en?: string;
}

export interface ImageInput {
  /** English tags. Korean input is converted to tags first. */
  prompt: string;
  /** Defaults to Settings.image.negativePrompt. */
  negativePrompt?: string;
  sourceKo?: string;
}

export class Studio {
  readonly client: NaiClient;

  constructor(
    readonly settings: Settings,
    fetcher?: Fetcher,
  ) {
    this.client = settings.mock
      ? new NaiClient('mock', fetcher ?? createMockFetcher())
      : new NaiClient(settings.apiKey.trim(), fetcher);
  }

  /** The output mode actually used with this model. Completion models can't write Korean. */
  effectiveMode(model: string): OutputMode {
    const mode = this.settings.outputMode;
    return mode === 'direct-ko' && modelInfo(model).kind === 'completion' ? 'translate' : mode;
  }

  // ------------------------------------------------------------ account

  verifyKey(signal?: AbortSignal): Promise<AccountInfo> {
    return this.client.getAccount(signal);
  }

  async listTextModels(signal?: AbortSignal): Promise<TextModelInfo[]> {
    try {
      return mergeModelList(await this.client.listModels(signal));
    } catch {
      return KNOWN_TEXT_MODELS;
    }
  }

  // ------------------------------------------------------------ novel

  async continueStory(story: Story, o: RunOptions & { instruction?: string } = {}): Promise<Story> {
    const model = story.model || this.settings.textModel;
    const info = modelInfo(model);
    const mode = this.effectiveMode(model);
    const params = genParamsFor(this.settings, model);
    const budget = contextBudgetChars(this.settings, model);
    const cache = { ...(story.cache ?? {}) };
    const report = reporter(o);
    const writeKo = mode === 'direct-ko';
    const instruction = o.instruction?.trim() ?? '';

    report('preparing', '', '');
    let segments = story.segments;
    let systemPrompt = story.systemPrompt;
    let authorsNote = story.authorsNote;
    let instructionForModel = instruction;
    if (!writeKo) {
      systemPrompt = await this.toEnglish(systemPrompt, story.glossary, cache, o.signal);
      authorsNote = await this.toEnglish(authorsNote, story.glossary, cache, o.signal);
      instructionForModel = await this.toEnglish(instruction, story.glossary, cache, o.signal);
      segments = await this.fillEnglish(segments, budget, story.glossary, o.signal);
    }

    const full = joinField(segments, writeKo ? 'ko' : 'en');
    const tail = tailChars(full, budget);
    const onText = (t: string) => report('generating', writeKo ? '' : t, writeKo ? t : '');
    report('generating', '', '');

    let out: string;
    if (info.kind === 'chat') {
      const raw = await this.client.chat({
        model,
        messages: novelChatMessages({
          systemPrompt,
          authorsNote,
          instruction: instructionForModel,
          storyTail: tail,
          language: writeKo ? 'Korean' : 'English',
          maxTokens: params.maxTokens,
        }),
        params,
        signal: o.signal,
        onText,
      });
      const body = cleanModelText(raw).trim();
      out = body ? joinSeparator(full, body) + body : '';
    } else {
      const { input, instruct } = novelCompletionPrompt({ systemPrompt, authorsNote, instruction: instructionForModel, storyTail: tail });
      out = await this.client.complete({ model, input, instruct, params, signal: o.signal, onText, stopAt: ['\n***', '\n[ ', '\n{ '] });
      if (instruct && full && !full.endsWith('\n')) out = '\n' + out.replace(/^\n+/, '');
      out = out.replace(/\s+$/, '');
    }
    if (!out.trim()) throw new NaiError('모델이 빈 응답을 돌려줬어요. 다시 시도해 주세요.');

    const en = writeKo ? '' : out;
    let ko = writeKo ? out : '';
    if (mode === 'translate') {
      report('translating', en, '');
      ko = await translate({
        client: this.client,
        settings: this.settings,
        direction: 'en2ko',
        text: en,
        glossary: story.glossary,
        context: contextPairs(segments, 'en2ko'),
        signal: o.signal,
        onText: (t) => report('translating', en, t),
      });
    }
    report('done', en, ko);

    const seg: Segment = { id: uid(), en, ko, author: 'ai', instruction: instruction || undefined, createdAt: Date.now() };
    return { ...story, segments: [...segments, seg], cache, updatedAt: Date.now() };
  }

  /** Replaces the last AI segment with a fresh one (same instruction unless a new one is given). */
  async rerollStory(story: Story, o: RunOptions & { instruction?: string } = {}): Promise<Story> {
    const last = story.segments.at(-1);
    if (!last || last.author !== 'ai') throw new NaiError('다시 쓸 AI 문단이 없어요.');
    return this.continueStory(
      { ...story, segments: story.segments.slice(0, -1) },
      { ...o, instruction: o.instruction ?? last.instruction },
    );
  }

  /** Appends text the user wrote (Korean or English). */
  async addUserText(story: Story, text: string, o: RunOptions = {}): Promise<Story> {
    const t = text.trim();
    if (!t) return story;
    const model = story.model || this.settings.textModel;
    const mode = this.effectiveMode(model);
    const report = reporter(o);

    let en = '';
    let ko = '';
    if (mode === 'direct-ko') {
      ko = t;
    } else if (hasHangul(t)) {
      ko = t;
      report('translating', '', ko);
      en = await this.tr('ko2en', ko, story.glossary, contextPairs(story.segments, 'ko2en'), o.signal, (x) => report('translating', x, ko));
    } else {
      en = t;
      if (mode === 'translate') {
        report('translating', en, '');
        ko = await this.tr('en2ko', en, story.glossary, contextPairs(story.segments, 'en2ko'), o.signal, (x) => report('translating', en, x));
      }
    }
    const full = joinField(story.segments, mode === 'direct-ko' ? 'ko' : 'en');
    const sep = joinSeparator(full, mode === 'direct-ko' ? ko : en);
    report('done', en && sep + en, ko && sep + ko);

    const seg: Segment = { id: uid(), en: en && sep + en, ko: ko && sep + ko, author: 'user', createdAt: Date.now() };
    return { ...story, segments: [...story.segments, seg], updatedAt: Date.now() };
  }

  async editSegment(story: Story, segmentId: string, edit: EditInput, o: RunOptions = {}): Promise<Story> {
    const mode = this.effectiveMode(story.model || this.settings.textModel);
    const segments = await this.editItem(story.segments, segmentId, edit, mode, story.glossary, o);
    return { ...story, segments, updatedAt: Date.now() };
  }

  /** Translates one segment's English again (e.g. after changing the glossary). */
  async retranslateSegment(story: Story, segmentId: string, o: RunOptions = {}): Promise<Story> {
    const seg = story.segments.find((s) => s.id === segmentId);
    if (!seg?.en.trim()) throw new NaiError('번역할 영어 원문이 없어요.');
    return this.editSegment(story, segmentId, { en: seg.en }, o);
  }

  /** Fills in Korean for segments/messages that only have English (e.g. written in 'english' mode). */
  async fillMissingKorean<T extends Story | Chat>(doc: T, o: RunOptions = {}): Promise<T> {
    const items: Bilingual[] = 'segments' in doc ? doc.segments : doc.messages;
    const out = [...items];
    for (let i = 0; i < out.length; i++) {
      const it = out[i];
      if (it.ko.trim() || !it.en.trim()) continue;
      const ko = await this.tr('en2ko', it.en, doc.glossary, contextPairs(out.slice(0, i), 'en2ko'), o.signal, (x) =>
        o.onProgress?.({ phase: 'translating', en: it.en, ko: x }),
      );
      out[i] = { ...it, ko: mirrorEdgeWhitespace(it.en, ko) };
    }
    o.onProgress?.({ phase: 'done', en: '', ko: '' });
    return 'segments' in doc
      ? { ...doc, segments: out as Segment[], updatedAt: Date.now() }
      : { ...doc, messages: out as ChatMessage[], updatedAt: Date.now() };
  }

  // ------------------------------------------------------------ chat

  /**
   * Adds the user's message and generates the reply.
   * `onUserMessage` fires once the user's message is ready (translated), before generation starts.
   */
  async sendChat(chat: Chat, text: string, o: RunOptions & { onUserMessage?: (chat: Chat) => void } = {}): Promise<Chat> {
    const t = text.trim();
    let next = chat;
    if (t) {
      const mode = this.effectiveMode(chat.model || this.settings.textModel);
      let en = '';
      let ko = '';
      if (mode === 'direct-ko') ko = t;
      else if (hasHangul(t)) {
        ko = t;
        o.onProgress?.({ phase: 'preparing', en: '', ko });
        en = await this.tr('ko2en', ko, chat.glossary, contextPairs(chat.messages, 'ko2en'), o.signal);
      } else en = t;
      const msg: ChatMessage = { id: uid(), role: 'user', en, ko, createdAt: Date.now() };
      next = { ...chat, messages: [...chat.messages, msg], updatedAt: Date.now() };
      o.onUserMessage?.(next);
    }
    return this.generateReply(next, o);
  }

  async generateReply(chat: Chat, o: RunOptions = {}): Promise<Chat> {
    const model = chat.model || this.settings.textModel;
    const info = modelInfo(model);
    const mode = this.effectiveMode(model);
    const params = genParamsFor(this.settings, model);
    const budget = contextBudgetChars(this.settings, model);
    const cache = { ...(chat.cache ?? {}) };
    const report = reporter(o);
    const writeKo = mode === 'direct-ko';

    report('preparing', '', '');
    let { systemPrompt, charName, userName, messages } = chat;
    if (!writeKo) {
      systemPrompt = await this.toEnglish(systemPrompt, chat.glossary, cache, o.signal);
      charName = await this.toEnglish(charName, chat.glossary, cache, o.signal);
      userName = await this.toEnglish(userName, chat.glossary, cache, o.signal);
      messages = await this.fillEnglish(messages, budget, chat.glossary, o.signal);
    }

    const history: ChatLine[] = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const text = (writeKo ? m.ko || m.en : m.en || m.ko).trim();
      if (!text) continue;
      if (used + text.length > budget && history.length) break;
      used += text.length;
      history.unshift({ role: m.role, text });
    }

    const onText = (t: string) => report('generating', writeKo ? '' : t, writeKo ? t : '');
    report('generating', '', '');
    let out: string;
    if (info.kind === 'chat') {
      out = await this.client.chat({
        model,
        messages: chatMessages({ systemPrompt, charName, userName, history, language: writeKo ? 'Korean' : 'English' }),
        params,
        signal: o.signal,
        onText,
      });
    } else {
      const { input, stopAt } = chatCompletionPrompt({ systemPrompt, charName, userName, history });
      out = await this.client.complete({ model, input, stopAt, params, signal: o.signal, onText });
    }
    out = cleanModelText(out).trim();
    const name = charName || (info.kind === 'completion' ? 'Character' : '');
    if (name) out = out.replace(new RegExp(`^${escapeRe(name)}\\s*:\\s*`), '');
    if (!out) throw new NaiError('모델이 빈 응답을 돌려줬어요. 다시 시도해 주세요.');

    const en = writeKo ? '' : out;
    let ko = writeKo ? out : '';
    if (mode === 'translate') {
      report('translating', en, '');
      ko = await this.tr('en2ko', en, chat.glossary, contextPairs(messages, 'en2ko'), o.signal, (t) => report('translating', en, t));
    }
    report('done', en, ko);

    const msg: ChatMessage = { id: uid(), role: 'assistant', en, ko, createdAt: Date.now() };
    return { ...chat, messages: [...messages, msg], cache, updatedAt: Date.now() };
  }

  /** Drops the last reply (if the chat ends with one) and generates a new one. */
  regenerateReply(chat: Chat, o: RunOptions = {}): Promise<Chat> {
    const last = chat.messages.at(-1);
    const messages = last?.role === 'assistant' ? chat.messages.slice(0, -1) : chat.messages;
    return this.generateReply({ ...chat, messages }, o);
  }

  async editMessage(chat: Chat, messageId: string, edit: EditInput, o: RunOptions = {}): Promise<Chat> {
    const mode = this.effectiveMode(chat.model || this.settings.textModel);
    const messages = await this.editItem(chat.messages, messageId, edit, mode, chat.glossary, o);
    return { ...chat, messages, updatedAt: Date.now() };
  }

  async retranslateMessage(chat: Chat, messageId: string, o: RunOptions = {}): Promise<Chat> {
    const m = chat.messages.find((x) => x.id === messageId);
    if (!m?.en.trim()) throw new NaiError('번역할 영어 원문이 없어요.');
    return this.editMessage(chat, messageId, { en: m.en }, o);
  }

  // ------------------------------------------------------------ images

  /**
   * Turns a Korean (or English) description into English Danbooru tags.
   * Set fromStory when passing a story passage rather than a picture description.
   */
  async textToTags(text: string, o: { fromStory?: boolean; signal?: AbortSignal; onText?: (t: string) => void } = {}): Promise<string> {
    const model = this.settings.translatorModel;
    const params = { ...genParamsFor(this.settings, model), temperature: 0.5, topP: 0.9, topK: 0, minP: 0, maxTokens: 400 };
    const raw = await this.client.chat({
      model,
      messages: tagMessages(text, Boolean(o.fromStory)),
      params,
      signal: o.signal,
      onText: (t) => o.onText?.(tidyTags(t)),
    });
    const tags = tidyTags(raw);
    if (!tags) throw new NaiError('태그를 만들지 못했어요. 묘사를 조금 더 구체적으로 적어 주세요.');
    return tags;
  }

  async generateImage(input: ImageInput, signal?: AbortSignal): Promise<GalleryImage> {
    let prompt = input.prompt.trim();
    if (!prompt) throw new NaiError('프롬프트를 입력해 주세요.');
    let sourceKo = input.sourceKo;
    if (hasHangul(prompt)) {
      sourceKo ??= prompt;
      prompt = await this.textToTags(prompt, { signal });
    }
    const s = this.settings.image;
    const negativePrompt = input.negativePrompt ?? s.negativePrompt;
    const r = await this.client.image({ prompt, negativePrompt, settings: s, signal });
    return {
      id: uid(),
      createdAt: Date.now(),
      blob: new Blob([r.bytes], { type: r.mime }),
      mime: r.mime,
      width: s.width,
      height: s.height,
      seed: r.seed,
      model: s.model,
      prompt,
      negativePrompt,
      sourceKo,
    };
  }

  // ------------------------------------------------------------ glossary

  /** Proposes glossary entries for names/terms in the English text that aren't listed yet. */
  async suggestGlossary(textEn: string, existing: GlossaryEntry[], signal?: AbortSignal): Promise<GlossaryEntry[]> {
    if (!textEn.trim()) return [];
    const model = this.settings.translatorModel;
    const params = { ...genParamsFor(this.settings, model), temperature: 0.2, topP: 0.9, topK: 0, minP: 0, maxTokens: 1500 };
    const raw = await this.client.chat({ model, messages: glossaryMessages(tailChars(textEn, 12000), existing), params, signal });
    const known = new Set(existing.map((g) => g.en.trim().toLowerCase()));
    return parseJsonArray(raw)
      .map((x) => ({ id: uid(), en: String(x?.en ?? '').trim(), ko: String(x?.ko ?? '').trim(), note: String(x?.note ?? '').trim() || undefined }))
      .filter((g) => g.en && g.ko && !known.has(g.en.toLowerCase()));
  }

  // ------------------------------------------------------------ internals

  private tr(direction: Direction, text: string, glossary: GlossaryEntry[], context: Pair[], signal?: AbortSignal, onText?: (t: string) => void) {
    return translate({ client: this.client, settings: this.settings, direction, text, glossary, context, signal, onText });
  }

  /** Korean settings text → English, cached on the document so it isn't re-translated every turn. */
  private async toEnglish(text: string, glossary: GlossaryEntry[], cache: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const t = text.trim();
    if (!t || !hasHangul(t)) return text;
    const exact = glossary.find((g) => g.ko.trim() === t);
    if (exact?.en.trim()) return exact.en.trim();
    const key = hash(`ko2en|${glossarySignature(glossary)}|${t}`);
    if (cache[key]) return cache[key];
    let en = (await this.tr('ko2en', t, glossary, [], signal)).trim();
    // Short one-liners are names: drop the period/quotes translators like to add.
    if (t.length <= 20 && !t.includes('\n')) en = en.replace(/^["'“‘]+|["'”’.]+$/g, '');
    cache[key] = en;
    return en;
  }

  /** Makes sure items inside the context window have English (e.g. a Korean greeting, or text written in direct-ko mode). */
  private async fillEnglish<T extends Bilingual>(items: T[], budget: number, glossary: GlossaryEntry[], signal?: AbortSignal): Promise<T[]> {
    const out = [...items];
    let used = 0;
    for (let i = out.length - 1; i >= 0 && used < budget; i--) {
      const it = out[i];
      if (!it.en.trim() && it.ko.trim()) {
        const en = await this.tr('ko2en', it.ko, glossary, [], signal);
        out[i] = { ...it, en: mirrorEdgeWhitespace(it.ko, en) };
      }
      used += (out[i].en || out[i].ko).length;
    }
    return out;
  }

  private async editItem<T extends Bilingual>(
    items: T[],
    id: string,
    edit: EditInput,
    mode: OutputMode,
    glossary: GlossaryEntry[],
    o: RunOptions,
  ): Promise<T[]> {
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) throw new NaiError('수정할 항목을 찾지 못했어요.');
    const item = items[idx];
    const before = items.slice(0, idx);
    let { en, ko } = item;

    if (edit.en !== undefined && edit.ko !== undefined) {
      en = edit.en;
      ko = edit.ko;
    } else if (edit.ko !== undefined) {
      ko = mirrorEdgeWhitespace(item.ko || item.en, edit.ko);
      if (mode !== 'direct-ko') {
        o.onProgress?.({ phase: 'translating', en: '', ko });
        const t = await this.tr('ko2en', ko, glossary, contextPairs(before, 'ko2en'), o.signal, (x) =>
          o.onProgress?.({ phase: 'translating', en: x, ko }),
        );
        en = mirrorEdgeWhitespace(item.en || ko, t);
      }
    } else if (edit.en !== undefined) {
      en = mirrorEdgeWhitespace(item.en || item.ko, edit.en);
      if (mode === 'translate') {
        o.onProgress?.({ phase: 'translating', en, ko: '' });
        const t = await this.tr('en2ko', en, glossary, contextPairs(before, 'en2ko'), o.signal, (x) =>
          o.onProgress?.({ phase: 'translating', en, ko: x }),
        );
        ko = mirrorEdgeWhitespace(en, t);
      }
    }
    o.onProgress?.({ phase: 'done', en, ko });
    const out = [...items];
    out[idx] = { ...item, en, ko };
    return out;
  }
}

export function createStudio(settings: Settings, fetcher?: Fetcher): Studio {
  return new Studio(settings, fetcher);
}

// ------------------------------------------------------------ helpers

function reporter(o: RunOptions) {
  return (phase: Phase, en: string, ko: string) => o.onProgress?.({ phase, en, ko });
}

function joinField(items: Bilingual[], field: 'en' | 'ko'): string {
  return items.map((s) => s[field] || (field === 'ko' ? s.en : s.ko)).join('');
}

/** How to glue a new passage onto the story: nothing, a space, or a paragraph break. */
export function joinSeparator(prev: string, next: string): string {
  if (!prev || /^\s/.test(next)) return '';
  if (/\n$/.test(prev)) return '';
  const endsSentence = /[.!?。…"'”’)\]*~다요죠네까]\s*$/.test(prev);
  if (!endsSentence && /^[a-z,;:\-–—]/.test(next)) return ' ';
  return '\n\n';
}

/**
 * Previous translations as context for the translator. Uses aligned trailing paragraphs
 * so a long previous segment still contributes its last few lines.
 */
function contextPairs(items: Bilingual[], direction: Direction): Pair[] {
  const pairs: Pair[] = [];
  let total = 0;
  for (let i = items.length - 1; i >= 0 && pairs.length < 3 && total < 2500; i--) {
    const { en, ko } = items[i];
    if (!en.trim() || !ko.trim()) continue;
    const enParas = en.split(/\n+/).filter((p) => p.trim());
    const koParas = ko.split(/\n+/).filter((p) => p.trim());
    if (enParas.length !== koParas.length) continue;
    let k = enParas.length;
    let size = 0;
    while (k > 0 && size + enParas[k - 1].length + koParas[k - 1].length <= 2500 - total) {
      k--;
      size += enParas[k].length + koParas[k].length;
    }
    if (k === enParas.length) break;
    const src = enParas.slice(k).join('\n\n');
    const dst = koParas.slice(k).join('\n\n');
    pairs.unshift(direction === 'en2ko' ? { src, dst } : { src: dst, dst: src });
    total += size;
  }
  return pairs;
}

function glossarySignature(glossary: GlossaryEntry[]): string {
  return hash(glossary.map((g) => `${g.en}=${g.ko}`).join(';'));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tidyTags(s: string): string {
  const line = cleanModelText(s)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^(tags?|prompt)\s*:?\s*$/i.test(l));
  return (line ?? '')
    .replace(/^(tags?|prompt)\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonArray(s: string): any[] {
  const text = cleanModelText(s);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
