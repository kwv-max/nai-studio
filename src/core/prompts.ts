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

export interface TagPromptOptions {
  /** The input is a story passage (pick a moment) rather than a picture description. */
  fromStory: boolean;
  family: 'v5' | 'v4' | 'v3';
  /** Character prompts the target model accepts (0 = everything goes in base). */
  maxCharacters: number;
  /** Character/world notes (story system prompt, glossary) for consistent appearance. */
  reference?: string;
}

interface TagExample {
  input: string;
  base: string;
  characters: { name: string; prompt: string; position: string }[];
}

const MODEL_NAMES = { v5: 'NAI Diffusion V5', v4: 'NAI Diffusion V4.5', v3: 'NAI Diffusion V3' } as const;

// Worked examples, sent as prior turns. They teach the JSON shape and the level of detail better than rules alone.
const TAG_EXAMPLES: TagExample[] = [
  {
    input: '비 오는 밤, 등대 창가에 서서 바다를 바라보는 은발 소녀. 흰 원피스를 입었고 쓸쓸해 보인다.',
    base: '1girl, solo, upper body, from side, indoors, lighthouse, window, rain on glass, night, rain, ocean, dim lighting, moonlight, long hair, silver hair, white dress, sleeveless dress, standing, looking outside, hand on glass, sad, downcast eyes, closed mouth',
    characters: [],
  },
  {
    input: '해질녘 벚꽃 아래에서 금발 기사 소년이 검은 머리 마법사 소녀를 꼭 껴안고 있다. 소녀는 울고 있다.',
    base: '1girl, 1boy, cowboy shot, outdoors, cherry blossoms, falling petals, sunset, orange sky, backlighting',
    characters: [
      { name: '기사 소년', prompt: 'boy, blonde hair, short hair, knight, silver armor, cape, closed eyes, gentle smile, source#hug', position: 'left' },
      { name: '마법사 소녀', prompt: 'girl, black hair, long hair, witch, black robe, witch hat, crying, tears, blush, open mouth, target#hug', position: 'right' },
    ],
  },
  {
    input: '폐허가 된 성당 안으로 햇빛이 쏟아진다.',
    base: 'no humans, scenery, wide shot, indoors, church, ruins, broken window, stained glass, light rays, sunlight, dust particles, overgrown, ivy, rubble, stone floor',
    characters: [],
  },
];

/**
 * Description → NovelAI image prompt as JSON {base, characters[]}.
 * Rules follow NovelAI's official prompting docs (tag order, multi-character prompts, action tags).
 */
export function tagMessages(description: string, o: TagPromptOptions): ChatTurn[] {
  const multi = o.maxCharacters > 0;
  const v5 = o.family === 'v5';

  const characterRules = multi
    ? `## characters
- Exactly one person (or none): keep "characters" empty and put that person's tags in base, right after the scene tags.
- Two or more people: one entry per person (at most ${o.maxCharacters}). Base keeps only the count tags and the scene; every personal detail goes into that person's entry so traits don't leak between people.
- Each "prompt" describes only that person and has no number: start with girl / boy / woman / man / old man / little girl …, then
  hair length + color + style ("long hair, silver hair, ponytail, blunt bangs"), eye color ("blue eyes"), body and age cues ("tall", "mature female", "muscular"),
  clothing piece by piece ("white shirt, black pleated skirt, thighhighs"), accessories, expression ("smile", "blush", "tears", "frown", "open mouth"),
  pose and action ("sitting", "looking at viewer", "holding sword", "crossed arms").
- Interactions between people use action tags in both prompts: the doer gets "source#hug", the receiver "target#hug"; when both do it together, each gets "mutual#holding hands". After the "#" use the plain Danbooru action (hug, kiss, headpat, carrying, holding hands, pointing at another …).
- "position": where that person is in the frame: auto, left, center, right, top or bottom. Use auto unless the scene implies a layout.
- "name": a short label in the description's language, only so the user can tell entries apart.`
    : `## characters
This model has no per-character prompts: always return "characters": [] and put every person's tags into base, one person after another.`;

  const system = [
    `${MARK_TAGS}
Target model: ${MODEL_NAMES[o.family]}. It was trained on Danbooru tags, so write Danbooru tags: lowercase English, spaces instead of underscores, separated by commas.

Reply with JSON only (no code fences, no comments):
{"base": "...", "characters": [{"name": "...", "prompt": "...", "position": "auto"}]}`,
    `## base
The whole picture, in this order:
1. Count tags first: "1girl", "1boy", "2girls", "1girl, 1boy", "3girls, 1boy" … Add "solo" for exactly one person. Use "no humans" (plus "scenery" for landscapes) when nobody is in it.${
      v5 ? ' For a picture with no humans, start base with "background dataset, ".' : ''
    }
2. Only for well-known existing characters: their character tag and series tag (e.g. "hatsune miku, vocaloid"). Never write names of original characters as tags; describe how they look instead.
3. Framing and camera: portrait, upper body, cowboy shot, full body, close-up, wide shot, from above, from below, from side, from behind, dutch angle, pov.
4. Place and objects: indoors / outdoors, the concrete location (bedroom, classroom, cafe, forest, city street, castle, beach …) and notable objects.
5. Time, weather, light, mood: day, night, sunset, rain, snow, fog, sunlight, moonlight, backlighting, rim lighting, light rays, dim lighting, candlelight, neon lights.
6. Art style only if the description asks for one (watercolor, sketch, monochrome, chibi …).`,
    characterRules,
    `## Rules
- Use only concrete, visible tags that exist on Danbooru. Turn ideas into what can be seen: "lonely" → "sad, downcast eyes, alone"; "rich lady" → describe the dress and jewelry.
- Keep every detail the user gave (colors, clothes, objects, actions). Don't invent hair or eye colors that weren't given${o.reference?.trim() ? ' or found in the reference' : ''}.
- Be specific: about 15–35 tags for a single-person picture, 8–25 per character entry.
- No quality or aesthetic tags (masterpiece, best quality, very aesthetic, absurdres …) and no negative tags; the app adds those.
- No duplicates. No sentences${
      v5 ? ', except that V5 understands English: you may end base with one short sentence for a pose, layout or interaction that tags cannot express' : ''
    }.
- If the scene clearly shows nudity or sexual activity, put "nsfw" right after the count tags; otherwise never add it.${
      v5 ? '\n- Visible written text (a sign, a speech bubble) only if the description asks for it: add "speech bubble" or "sign" and end base with: Text: <the exact words>' : ''
    }`,
    o.fromStory
      ? 'The user message is a passage from a story. Draw its single most visual moment (one instant, one place); ignore what happens before or after.'
      : '',
    o.reference?.trim()
      ? `## Reference
Notes about the story's characters and world. Use them only for the fixed appearance (hair, eyes, usual outfit, age) of characters who appear in the scene; don't draw anything that isn't in the scene.
${o.reference.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const msgs: ChatTurn[] = [{ role: 'system', content: system }];
  for (const ex of TAG_EXAMPLES) {
    let base = multi ? ex.base : [ex.base, ...ex.characters.map((c) => c.prompt)].join(', ');
    if (v5 && base.startsWith('no humans')) base = `background dataset, ${base}`;
    msgs.push({ role: 'user', content: ex.input });
    msgs.push({ role: 'assistant', content: JSON.stringify({ base, characters: multi ? ex.characters : [] }) });
  }
  msgs.push({ role: 'user', content: description.trim() });
  return msgs;
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
