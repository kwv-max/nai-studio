// Shared data shapes. The UI reads and writes these; the core never touches the DOM.

/** 'chat' models go through /oa/v1/chat/completions, 'completion' models through /ai/generate-stream. */
export type ModelKind = 'chat' | 'completion';

export interface TextModelInfo {
  id: string;
  label: string;
  kind: ModelKind;
  /** Short Korean description for the model picker. */
  note: string;
  /** Hard cap on output tokens per request for this model. */
  maxOutputTokens: number;
}

/**
 * - translate: the model writes English, GLM translates to Korean (default).
 * - direct-ko: chat models write Korean directly; no translation step. Completion models fall back to translate.
 * - english: no translation at all.
 */
export type OutputMode = 'translate' | 'direct-ko' | 'english';

export interface GenParams {
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  maxTokens: number;
}

export interface GlossaryEntry {
  id: string;
  en: string;
  ko: string;
  /** e.g. "반말, 쾌활한 20대 여성". Passed to the translator as a style hint. */
  note?: string;
}

export interface AccountInfo {
  tier: number;
  tierName: string;
  active: boolean;
  expiresAt: number | null;
  anlas: number;
  /** Context size in tokens for completion models (Erato/Kayra) on this tier. */
  contextTokens: number | null;
}

export interface ImageSettings {
  model: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  cfgRescale: number;
  sampler: string;
  noiseSchedule: string;
  negativePrompt: string;
  /** Appends the model's recommended quality tags to the prompt. */
  qualityTags: boolean;
  /** -1 = random each time. */
  seed: number;
  /** V5 only: real alpha-transparent background. */
  transparent: boolean;
  /** Lets GLM reason before writing tags. Slower, usually more accurate. */
  thoroughTags: boolean;
}

/** One character's own prompt (V4+ multi-character prompting). */
export interface CharacterPrompt {
  /** Short label for the user, e.g. "엘리제". Not sent to the model. */
  name: string;
  /** Tags for this character only, without a count ("girl, silver hair, …"). */
  prompt: string;
  /** auto | left | center | right | top | bottom */
  position: string;
}

/** A full image prompt: scene-level tags plus per-character prompts. */
export interface ImagePrompt {
  /** Count tags, framing, setting, lighting; or everything for a single character. */
  base: string;
  characters: CharacterPrompt[];
}

export interface Settings {
  apiKey: string;
  /** false = the key is kept only for this browser tab session. */
  rememberKey: boolean;
  /** Generation model for novel and chat. */
  textModel: string;
  /** Model used for translation, tag conversion and glossary extraction. */
  translatorModel: string;
  outputMode: OutputMode;
  /** Free-form Korean style guide for the translator, e.g. "소설체, 과거형 서술". */
  translationStyle: string;
  /** Characters of story/chat history sent as context. 0 = automatic. */
  contextChars: number;
  /** Per-model overrides of generation parameters. Missing fields fall back to model defaults. */
  genByModel: Record<string, Partial<GenParams>>;
  image: ImageSettings;
  /** Demo mode: fake responses, no network, no key needed. */
  mock: boolean;
  /** Cached from the last key check. */
  account: AccountInfo | null;
}

export interface Segment {
  id: string;
  /** Canonical text the model sees. May start with a space or newline: segments are continuous prose. */
  en: string;
  /** Korean shown to the user. Empty until translated (or when outputMode is 'english'). */
  ko: string;
  author: 'ai' | 'user';
  /** Korean instruction the user gave for this continuation, if any. */
  instruction?: string;
  createdAt: number;
}

export interface Story {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** System prompt / memory: world, characters, style. Korean or English. */
  systemPrompt: string;
  /** Short steering note placed near the end of the context. Korean or English. */
  authorsNote: string;
  glossary: GlossaryEntry[];
  segments: Segment[];
  /** Overrides Settings.textModel for this story. */
  model?: string;
  /** Translation cache for system prompt / notes / names (hash -> text). */
  cache?: Record<string, string>;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  en: string;
  ko: string;
  createdAt: number;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** System prompt: character, scenario, rules. Korean or English. */
  systemPrompt: string;
  charName: string;
  userName: string;
  glossary: GlossaryEntry[];
  messages: ChatMessage[];
  model?: string;
  cache?: Record<string, string>;
}

export interface GalleryImage {
  id: string;
  createdAt: number;
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  seed: number;
  model: string;
  /** Base prompt as typed (quality tags are added at request time). */
  prompt: string;
  /** Per-character prompts, if any. */
  characters?: CharacterPrompt[];
  negativePrompt: string;
  /** The Korean description the prompt was made from, if any. */
  sourceKo?: string;
}

export type Phase = 'preparing' | 'generating' | 'translating' | 'done';

export interface Progress {
  phase: Phase;
  /** Accumulated English so far (the model's original). */
  en: string;
  /** Accumulated Korean so far. */
  ko: string;
}

export type ProgressHandler = (p: Progress) => void;

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: ProgressHandler;
}
