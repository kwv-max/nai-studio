/** Error with a Korean message that is safe to show the user as-is. */
export class NaiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly detail: string = '',
  ) {
    super(message);
    this.name = 'NaiError';
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : (e as { name?: string })?.name === 'AbortError';
}

export function abortError(): DOMException {
  return new DOMException('사용자가 중단했어요.', 'AbortError');
}

export function messageForStatus(status: number, detail: string): string {
  const d = detail.toLowerCase();
  switch (status) {
    case 400:
      if (d.includes('context') || d.includes('too long') || d.includes('length'))
        return '입력이 모델의 컨텍스트 한도를 넘었어요. 설정에서 컨텍스트 길이를 줄여 주세요.';
      return `요청 형식이 올바르지 않아요. (${detail || '400'})`;
    case 401:
      return 'API 키가 올바르지 않아요. NovelAI 계정 설정에서 발급한 Persistent API Token(pst-로 시작)을 넣어 주세요.';
    case 402:
      return 'Anlas가 부족해요. 이미지 크기나 스텝 수를 줄여 보세요.';
    case 403:
      return '현재 구독 등급에서 쓸 수 없는 모델이에요.';
    case 409:
      return '요청이 다른 작업과 충돌했어요. 잠시 후 다시 시도해 주세요.';
    case 429:
      return '다른 생성이 아직 진행 중이에요. 끝난 뒤 다시 시도해 주세요.';
    default:
      if (status >= 500) return `NovelAI 서버 오류예요. 잠시 후 다시 시도해 주세요. (${status})`;
      return `요청이 실패했어요. (${status}${detail ? `: ${detail}` : ''})`;
  }
}

/** Turns a non-OK response into a NaiError. */
export async function errorFromResponse(res: Response): Promise<NaiError> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = String(j?.message ?? j?.error?.message ?? j?.error ?? text);
    } catch {
      detail = text.slice(0, 300);
    }
  } catch {
    // body unreadable
  }
  return new NaiError(messageForStatus(res.status, detail), res.status, detail);
}
