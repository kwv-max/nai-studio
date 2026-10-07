export interface SseEvent {
  event: string;
  data: string;
}

/** Parses a text/event-stream body. Handles \r\n, multi-line data and comment lines. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];

  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(buf[nl] === '\r' ? nl + 2 : nl + 1);

        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
        } else if (line.startsWith(':')) {
          // comment / keep-alive
        } else {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
      }
    }
    buf += decoder.decode();
    if (buf.startsWith('data:')) data.push(buf.slice(5).trimStart());
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  if (signal?.aborted) throw new DOMException('사용자가 중단했어요.', 'AbortError');
}
