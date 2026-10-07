export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** FNV-1a, used as a cache key for translated snippets. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

export function hasHangul(s: string): boolean {
  return /[ᄀ-ᇿ㄰-㆏가-힯]/.test(s);
}

/**
 * Removes reasoning blocks. An unclosed <think> (still streaming) hides everything after it.
 */
export function stripThinking(s: string): string {
  let out = s.replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = out.indexOf('<think>');
  if (open >= 0) out = out.slice(0, open);
  return out;
}

/** Strips wrappers models sometimes add around a bare answer. */
export function cleanModelText(s: string): string {
  let out = stripThinking(s);
  const fence = out.match(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i);
  if (fence) out = fence[1];
  return out;
}

const LEADING_WS = /^\s*/;
const TRAILING_WS = /\s*$/;

/** Gives `target` the same leading/trailing whitespace as `source` so segments join the same way in both languages. */
export function mirrorEdgeWhitespace(source: string, target: string): string {
  const lead = source.match(LEADING_WS)?.[0] ?? '';
  const trail = source.match(TRAILING_WS)?.[0] ?? '';
  const core = target.trim();
  if (!core) return target;
  return lead + core + (source.trim() ? trail : '');
}

/** Takes the last `maxChars` of `text`, cut at a paragraph or sentence boundary when possible. */
export function tailChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(text.length - maxChars);
  const para = slice.indexOf('\n');
  if (para >= 0 && para < maxChars * 0.3) return slice.slice(para + 1);
  const sentence = slice.search(/[.!?。]\s/);
  if (sentence >= 0 && sentence < maxChars * 0.3) return slice.slice(sentence + 2);
  return slice;
}

/** Splits text into chunks of at most `max` chars, breaking only at newlines when possible. */
export function chunkByParagraph(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const lines = text.split(/(?<=\n)/);
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length > max) {
      chunks.push(cur);
      cur = '';
    }
    if (line.length > max) {
      // A single giant paragraph: fall back to sentence breaks.
      const sentences = line.split(/(?<=[.!?。]\s)/);
      for (const s of sentences) {
        if (cur && cur.length + s.length > max) {
          chunks.push(cur);
          cur = '';
        }
        cur += s;
      }
    } else {
      cur += line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Rejects immediately if the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('사용자가 중단했어요.', 'AbortError');
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('사용자가 중단했어요.', 'AbortError'));
      },
      { once: true },
    );
  });
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  return 'application/octet-stream';
}
