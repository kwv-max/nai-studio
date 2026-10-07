// Every prompt the app sends lives here, so wording can be tuned in one place.
import type { ChatTurn } from './nai';
import type { GlossaryEntry } from './types';

export type Direction = 'en2ko' | 'ko2en';

// The mock fetcher keys off these first lines, so keep them stable.
export const MARK_EN2KO = 'You are a professional literary translator working from English into Korean.';
export const MARK_KO2EN = 'You are a professional literary translator working from Korean into English.';
export const MARK_TAGS = "You turn scene descriptions into prompts for NovelAI's anime image model.";
export const MARK_GLOSSARY = 'Extract proper nouns from the English fiction text below.';

function glossaryBlock(glossary: GlossaryEntry[], direction: Direction): string {
  const rows = glossary.filter((g) => g.en.trim() && g.ko.trim());
  if (!rows.length) return '';
  const lines = rows.map((g) => {
    const pair = direction === 'en2ko' ? `${g.en} → ${g.ko}` : `${g.ko} → ${g.en}`;
    return g.note?.trim() ? `- ${pair} (${g.note.trim()})` : `- ${pair}`;
  });
  return `\n\nGlossary (always use these renderings; notes describe how the character talks):\n${lines.join('\n')}`;
}

export function translatorSystem(direction: Direction, glossary: GlossaryEntry[], style: string): string {
  const head =
    direction === 'en2ko'
      ? `${MARK_EN2KO}
Translate the user's text into natural, fluent Korean that reads like a published Korean novel.
Rules:
- Output only the Korean translation. No notes, labels, explanations or original text.
- Keep every paragraph and line break exactly where the source has them.
- Use Korean dialogue punctuation and give each speaker a consistent speech level (반말/존댓말) and tone.
- Keep names and terms consistent with the glossary and with earlier turns of this conversation.
- Translate faithfully: do not omit, soften, summarize or add anything.`
      : `${MARK_KO2EN}
Translate the user's text into natural English. If it is story text, write it as fiction prose; if it is an instruction or note, keep it an instruction or note.
Rules:
- Output only the English translation. No notes, labels or explanations.
- Keep every paragraph and line break exactly where the source has them.
- Keep names and terms consistent with the glossary.
- Translate faithfully: do not omit or add anything.`;
  const styleLine = style.trim() && direction === 'en2ko' ? `\n\nStyle guide from the reader (in Korean): ${style.trim()}` : '';
  return head + glossaryBlock(glossary, direction) + styleLine;
}

export interface Pair {
  src: string;
  dst: string;
}

/** Earlier translations become prior turns so the model keeps names and tone consistent. */
export function translatorMessages(
  direction: Direction,
  text: string,
  glossary: GlossaryEntry[],
  style: string,
  context: Pair[],
): ChatTurn[] {
  const msgs: ChatTurn[] = [{ role: 'system', content: translatorSystem(direction, glossary, style) }];
  for (const p of context) {
    msgs.push({ role: 'user', content: p.src.trim() });
    msgs.push({ role: 'assistant', content: p.dst.trim() });
  }
  msgs.push({ role: 'user', content: text.trim() });
  return msgs;
}

// ---------------------------------------------------------------- novel

export interface NovelPromptInput {
  systemPrompt: string;
  authorsNote: string;
  instruction: string;
  storyTail: string;
  language: 'English' | 'Korean';
  maxTokens: number;
}

export function novelChatMessages(p: NovelPromptInput): ChatTurn[] {
  const length =
    p.language === 'English'
      ? `about ${Math.max(60, Math.round(p.maxTokens * 0.6))} words`
      : `about ${Math.max(150, Math.round(p.maxTokens * 1.1))} Korean characters`;
  const system = [
    p.systemPrompt.trim() && `## Story setting\n${p.systemPrompt.trim()}`,
    `## Your task
You are co-writing a novel. Continue the story from exactly where it stops.
- Write only new story text, in ${p.language}. Do not repeat, recap, title or comment on it.
- Match the established voice, tense and point of view.
- Write ${length}, ending at a natural break.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const user = [
    `## Story so far\n${p.storyTail.trim() || '(Nothing yet. Write the opening of the story.)'}`,
    p.authorsNote.trim() && `## Author's note\n${p.authorsNote.trim()}`,
    p.instruction.trim() && `## Direction for the next part\n${p.instruction.trim()}`,
    'Continue the story.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Erato/Kayra are plain text continuers: memory on top, `***` separator, then the story.
 * The author's note goes a few lines from the end in [ brackets ], instructions in { braces } (instruct mode).
 */
export function novelCompletionPrompt(p: Omit<NovelPromptInput, 'language' | 'maxTokens'>): { input: string; instruct: boolean } {
  let story = p.storyTail;
  if (p.authorsNote.trim()) {
    const lines = story.split('\n');
    const at = Math.max(0, lines.length - 3);
    lines.splice(at, 0, `[ ${p.authorsNote.trim()} ]`);
    story = lines.join('\n');
  }
  const instruct = Boolean(p.instruction.trim());
  if (instruct) {
    story = story.replace(/\s*$/, '') + `\n{ ${p.instruction.trim()} }\n`;
  }
  const memory = p.systemPrompt.trim();
  return { input: (memory ? `${memory}\n***\n` : '') + story, instruct };
}

// ---------------------------------------------------------------- chat

export interface ChatLine {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatPromptInput {
  systemPrompt: string;
  charName: string;
  userName: string;
  history: ChatLine[];
  language: 'English' | 'Korean';
}

export function chatMessages(p: ChatPromptInput): ChatTurn[] {
  const rules = [
    p.charName && `You are ${p.charName}${p.userName ? `, talking with ${p.userName}` : ''}.`,
    p.charName && `Stay in character and write only ${p.charName}'s reply. Never write ${p.userName || "the user"}'s words or actions.`,
    `Always reply in ${p.language}.`,
  ]
    .filter(Boolean)
    .join('\n');
  const system = p.systemPrompt.trim() ? `${p.systemPrompt.trim()}\n\n${rules}` : rules;
  return [{ role: 'system', content: system }, ...p.history.map((h) => ({ role: h.role, content: h.text }))];
}

/** Script format for completion models. Generation stops when the model starts another speaker's line. */
export function chatCompletionPrompt(p: Omit<ChatPromptInput, 'language'>): { input: string; stopAt: string[] } {
  const char = p.charName || 'Character';
  const user = p.userName || 'User';
  const lines = p.history.map((h) => `${h.role === 'user' ? user : char}: ${h.text.trim()}`);
  const memory = p.systemPrompt.trim();
  const input = (memory ? `${memory}\n***\n` : '') + [...lines, `${char}:`].join('\n');
  return { input, stopAt: [`\n${user}:`, `\n${char}:`, '\n***', '\n[ '] };
}

// ---------------------------------------------------------------- images and glossary

export function tagMessages(description: string, fromStory: boolean): ChatTurn[] {
  return [
    {
      role: 'system',
      content: `${MARK_TAGS}
Output one line of comma-separated English Danbooru-style tags and nothing else.
Order: number of people (1girl, 2boys, no humans...), well-known character names, appearance (hair, eyes, body), clothing, expression, pose and action, setting and background, lighting, framing.
Use concrete visual tags only. No sentences, no quality tags, no explanations.`,
    },
    {
      role: 'user',
      content: fromStory ? `Pick the most visual moment of this passage and write tags for it:\n\n${description.trim()}` : description.trim(),
    },
  ];
}

export function glossaryMessages(textEn: string, existing: GlossaryEntry[]): ChatTurn[] {
  const skip = existing.map((g) => g.en).filter(Boolean);
  return [
    {
      role: 'system',
      content: `${MARK_GLOSSARY}
Find character names, places, organizations and invented terms. For each, give the Korean rendering a Korean novel translator would use.
For characters, add a short Korean note on how they should talk in Korean (반말/존댓말, tone) if the text shows it.
Return only a JSON array: [{"en": "...", "ko": "...", "note": "..."}]. Return [] if there is nothing.${
        skip.length ? `\nSkip these, they are already listed: ${skip.join(', ')}` : ''
      }`,
    },
    { role: 'user', content: textEn.trim() },
  ];
}
