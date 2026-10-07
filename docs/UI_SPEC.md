# NAI 스튜디오 — UI spec

A mobile-first web app (installable PWA) for NovelAI: novel writing, character chat, and image generation.
Text models write in English; GLM translates the result to Korean. All UI copy is **Korean**.

The core logic is done and tested in `src/core/`. Your job is the UI on top of it.

## Hard rules

1. **Do not edit anything in `src/core/`.** Import only from `src/core` (the `index.ts` barrel). If you need something the core doesn't offer, write it down in `docs/CORE_REQUESTS.md` and work around it in the UI.
2. Stack: React 19 + TypeScript + Vite 8 (already installed). Plain CSS (one or a few `.css` files, CSS custom properties for theming). The only extra dependency you may add is `lucide-react` for icons. No Tailwind, no component libraries, no state libraries.
3. Put UI code in `src/ui/`, entry in `src/main.tsx`, HTML in `index.html` at the project root.
4. `npm run build` (type-check + build) and `npm test` must pass when you finish.
5. Never call `fetch` yourself for NovelAI. Everything goes through the `Studio` object.
6. Never auto-retry or loop generations. NovelAI's terms require every generation to come from a user action.
7. Only one generation at a time across the whole app (NovelAI rejects concurrent requests). Keep a global "busy" state and disable generate buttons while busy.

## Core API (what you call)

```ts
import {
  createStudio, loadSettings, saveSettings, db, newStory, newChat,
  isAbortError, NaiError, modelInfo, genParamsFor, defaultGenParams,
  IMAGE_MODELS, IMAGE_SIZES, IMAGE_SAMPLERS, isFreeForOpus, KNOWN_TEXT_MODELS,
  type Settings, type Story, type Chat, type Segment, type ChatMessage,
  type GalleryImage, type GlossaryEntry, type Progress, type TextModelInfo,
} from '../core';
```

- `loadSettings()` / `saveSettings(s)` — sync, localStorage. Save whenever settings change.
- `createStudio(settings)` — make a new one whenever settings change (`useMemo`). It's cheap.
- `db` — IndexedDB, async: `listStories/getStory/saveStory/deleteStory`, same for `Chat`s, `listImages/saveImage/deleteImage`, `exportAll(): Blob`, `importAll(file)`.
- `newStory(partial?)`, `newChat({ ...partial, greeting? })` — factories. A greeting becomes the first assistant message.

Every `Studio` operation takes a document and **returns an updated copy** (never mutates). Save the returned doc with `db.save*` and put it in state.

Long operations accept `{ signal, onProgress }`. `onProgress({ phase, en, ko })` fires many times while streaming, with the **full** text so far:

| phase | show the user |
|---|---|
| `preparing` | "준비 중…" (translating Korean settings/input to English) |
| `generating` | "영어로 쓰는 중…" — show `en` streaming (dim, smaller); in direct-Korean mode `ko` streams instead |
| `translating` | "번역 중…" — show `ko` streaming |
| `done` | final |

Stop button = `AbortController.abort()`. An aborted call rejects with an error where `isAbortError(e)` is true: ignore it silently (no toast). Any other error: show `e.message` in a toast — `NaiError` messages are already user-facing Korean.

### Novel
- `studio.continueStory(story, { instruction?, signal, onProgress })` — AI writes the next part. `instruction` = optional Korean direction ("다음 장면에서 둘이 다툰다").
- `studio.rerollStory(story, opts)` — replace the last AI segment.
- `studio.addUserText(story, text, opts)` — append text the user wrote (Korean or English).
- `studio.editSegment(story, segmentId, { ko } | { en }, opts)` — edit one side; the other side is re-translated.
- `studio.retranslateSegment(story, segmentId, opts)`
- `studio.fillMissingKorean(story, opts)` — translate segments that only have English.
- Segments are **continuous prose**: `segment.en`/`segment.ko` may start with a space or `\n\n`. Render the story as the concatenation of segments (respect `\n` as paragraph breaks, `white-space: pre-wrap` is fine), with each segment in its own tappable `<span>`/block so the user can act on it. Display `ko || en`.

### Chat
- `studio.sendChat(chat, text, { signal, onProgress, onUserMessage })` — `onUserMessage(chatWithUserMsg)` fires as soon as the user's message is ready; render it immediately, then stream the reply.
- `studio.generateReply(chat, opts)` — reply without new user input (e.g. "계속").
- `studio.regenerateReply(chat, opts)` — redo the last reply.
- `studio.editMessage(chat, id, { ko } | { en }, opts)`, `studio.retranslateMessage(chat, id, opts)`.
- Show `message.ko || message.en`.

### Images
- `studio.textToTags(text, { fromStory?, signal, onText })` — Korean description → English tags (streams via `onText`). `fromStory: true` when passing a story passage/chat message ("이 장면 그리기").
- `studio.generateImage({ prompt, negativePrompt?, sourceKo? }, signal)` → `GalleryImage` (has a `blob`). Save with `db.saveImage`. Show with `URL.createObjectURL(blob)` and revoke on unmount.
- Uses `settings.image` for model/size/steps/etc.

### Glossary & account
- `studio.suggestGlossary(englishText, existingGlossary, signal)` → proposed `GlossaryEntry[]`; let the user pick which to add.
- `studio.verifyKey(signal)` → `AccountInfo` (`tierName`, `anlas`, `expiresAt`, `contextTokens`). Store it in `settings.account`.
- `studio.listTextModels(signal)` → models for the picker (`label`, `note`, `kind`, `maxOutputTokens`).
- `studio.effectiveMode(modelId)` → the output mode actually used (Erato/Kayra can't write Korean directly).

## Screens

Bottom tab bar: **소설 · 채팅 · 이미지 · 설정**. If no API key and demo mode is off, open 설정 first with a short welcome.

### 설정 (Settings)
- **API 키**: password input with show/hide, "키 확인" button → `verifyKey` → show 등급, Anlas, 만료일. Help text: NovelAI 웹 → 설정 → Account → "Get Persistent API Token" (starts with `pst-`). Toggle "이 기기에 키 저장" (`rememberKey`).
- **데모 모드** toggle (`settings.mock`): fake responses, no key needed. Show a visible "데모" badge in the header when on.
- **글쓰기 모델** (`textModel`) picker from `listTextModels` with each model's `note`.
- **번역 모델** (`translatorModel`): chat-kind models only.
- **출력 방식** (`outputMode`): `translate` "영어로 쓰고 한국어로 번역 (추천)", `direct-ko` "한국어로 바로 쓰기 (GLM 계열만)", `english` "영어 그대로". When the chosen model is a completion model and `direct-ko` is chosen, show a note that it will translate instead.
- **생성 설정** for the current text model: 창의성(temperature), 출력 길이(maxTokens, max = `modelInfo(id).maxOutputTokens`), top_p for chat models. Stored in `settings.genByModel[modelId]`; defaults from `defaultGenParams`. "기본값으로" reset button.
- **번역 스타일** (`translationStyle`) textarea, placeholder "예: 소설체, 과거형 서술, 대사는 자연스러운 구어체".
- **컨텍스트 길이** (`contextChars`, 0 = 자동).
- **백업**: 내보내기 (`db.exportAll` → download `nai-studio-backup-YYYYMMDD.json`), 가져오기 (file input → `db.importAll`).
- Small footer: the key is stored only on this device and sent only to NovelAI.

### 소설 (Novel)
- **List**: stories sorted by update time, with title, snippet, date. New / delete (confirm).
- **Editor**:
  - Header: editable title, back, a "설정" sheet with: 시스템 프롬프트(메모리) textarea, 작가 노트 textarea, 용어집 editor, model override (default "기본 설정 따름").
  - Body: the story, comfortable reading typography (serif for prose, ~17–18px, generous line height). Display toggle: 한국어 / 원문 / 함께 보기 (함께 보기 = each segment shows Korean with English below in a smaller muted style).
  - Tap a segment → action sheet: 원문 보기, 수정 (edits Korean, or English when in 원문 view), 다시 번역, 이 장면 그리기, 삭제; on the last AI segment also 다시 쓰기.
  - Streaming: append a live block at the end showing the phase label and streaming text.
  - Bottom composer (sticky, above the keyboard): segmented control **AI에게 지시 | 직접 쓰기**, auto-growing textarea, primary button. Empty input + 지시 mode = plain continue ("이어쓰기"). While busy the button becomes **중지**.
  - Empty story: friendly prompt to set a system prompt and press 이어쓰기.

### 채팅 (Chat)
- **List**: chats with character name and last message. New chat form: 제목, 캐릭터 이름, 내 이름, 시스템 프롬프트 (placeholder with an example character sheet), 첫 메시지 (optional greeting), 모델.
- **Chat view**: bubbles (user right, assistant left), Korean text with a small "원문" toggle per bubble. Tap a bubble → 원문 보기, 수정, 다시 번역, 이 장면 그리기, 삭제; last assistant bubble also 다시 생성. Streaming reply bubble with phase label. Composer with send / 중지; a "계속" action that calls `generateReply` without input.
- Header "설정" sheet: edit system prompt, names, glossary, model.

### 이미지 (Image)
- **묘사** textarea (Korean) → "태그로 변환" → streams into the **태그** textarea (editable English tags). The user can also type tags directly.
- **생성** button → shows a loading state, then the image. Below it: 저장 (download), 공유 (`navigator.share` with a File when supported), 같은 시드로 (sets `settings.image.seed`), 삭제.
- Collapsible **옵션**: 모델 (`IMAGE_MODELS`), 크기 (`IMAGE_SIZES` chips), 스텝 (1–50), 가이던스 (scale 1–10), 샘플러 (`IMAGE_SAMPLERS`), 시드 (−1 = 랜덤), 네거티브 프롬프트, 품질 태그 자동 추가 toggle. Badge: "Opus 무료 범위" when `isFreeForOpus(settings)`, else "Anlas 소모".
- **갤러리** grid from `db.listImages()`; tap → full-screen viewer with prompt, seed, 프롬프트 재사용, 저장, 삭제.
- "이 장면 그리기" from novel/chat navigates here, runs `textToTags(segment.en || segment.ko, { fromStory: true })` into the tag box, and waits for the user to press 생성.

### Shared components
- **Glossary editor**: rows of 영어 | 한국어 | 메모(말투 등), add/delete; "자동 추출" button runs `suggestGlossary` on the document's English text and shows a checklist to add.
- Toasts for errors and short confirmations.
- Action sheet / bottom sheet component used everywhere above.

## Look and feel
- Mobile-first (360–430px wide), works fine on desktop (center column, max ~720px).
- Follow system light/dark (`prefers-color-scheme`), with a manual override in 설정 if you like.
- Safe-area insets (`env(safe-area-inset-*)`), `100dvh`, inputs ≥16px font (prevents iOS zoom), 44px touch targets.
- Calm, reading-focused design. Korean fonts: system fonts first (`-apple-system`, `"Apple SD Gothic Neo"`, `"Noto Sans KR"`, `"Malgun Gothic"`); serif for prose (`"Noto Serif KR"`, `"Nanum Myeongjo"`, serif).

## PWA
- `public/manifest.webmanifest` (name "NAI 스튜디오", short_name "NAI 스튜디오", `display: standalone`, theme/background colors, icons). Make simple SVG + PNG icons (192, 512, maskable). Link it from `index.html`, plus `apple-touch-icon` and `theme-color`.
- `public/sw.js`: cache the app shell for offline start. **Never cache or intercept requests to `*.novelai.net`.** Register it in `src/main.tsx` only in production builds (`import.meta.env.PROD`).
- Paths must be relative (the app may be hosted under a sub-path; `vite.config.ts` uses `base: './'`).

## Done when
- All four tabs work end-to-end in **데모 모드** (no key): novel continue/instruction/user text/edit/reroll/delete, chat send/regenerate/edit, tags → image → gallery, glossary auto-extract, backup export/import.
- `npm run build` and `npm test` pass.
- Write a short summary of what you built and anything you couldn't do in `docs/UI_NOTES.md`.
