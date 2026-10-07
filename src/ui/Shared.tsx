import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { isAbortError, type GlossaryEntry, type Progress } from '../core';

export function ActionSheet({ isOpen, onClose, children }: { isOpen: boolean; onClose: () => void; children: ReactNode }) {
  if (!isOpen) return null;
  return (
    <div className="sheet-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        {children}
      </div>
    </div>
  );
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Label for the streaming block. `writeKo` = the model writes Korean directly (no English phase). */
export function phaseLabel(p: Progress, writeKo: boolean): string {
  switch (p.phase) {
    case 'preparing': return '준비 중…';
    case 'generating': return writeKo ? '쓰는 중…' : '영어로 쓰는 중…';
    case 'translating': return '번역 중…';
    default: return '완료';
  }
}

/** Enter sends on devices with a real keyboard; on touch keyboards Enter inserts a newline. */
export function sendOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, send: () => void) {
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;
  e.preventDefault();
  send();
}

/** Grows a textarea with its content (up to its CSS max-height). */
export function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

export function GlossaryEditor({
  glossary,
  onChange,
  onSuggest,
  onError,
}: {
  glossary: GlossaryEntry[];
  onChange: (g: GlossaryEntry[]) => void;
  /** Runs auto-extraction; when given, shows the "자동 추출" button. */
  onSuggest?: () => Promise<GlossaryEntry[]>;
  onError?: (msg: string) => void;
}) {
  const [suggestions, setSuggestions] = useState<GlossaryEntry[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const addEntry = () => onChange([...glossary, { id: newId(), en: '', ko: '', note: '' }]);
  const updateEntry = (id: string, field: keyof GlossaryEntry, value: string) =>
    onChange(glossary.map((g) => (g.id === id ? { ...g, [field]: value } : g)));
  const deleteEntry = (id: string) => onChange(glossary.filter((g) => g.id !== id));

  const runSuggest = async () => {
    if (!onSuggest) return;
    setLoading(true);
    try {
      const found = await onSuggest();
      setSuggestions(found);
      setPicked(new Set(found.map((f) => f.id)));
      if (!found.length) onError?.('새로 추가할 용어를 찾지 못했어요.');
    } catch (e: any) {
      if (!isAbortError(e)) onError?.(e.message);
    } finally {
      setLoading(false);
    }
  };

  const addPicked = () => {
    if (!suggestions) return;
    onChange([...glossary, ...suggestions.filter((s) => picked.has(s.id))]);
    setSuggestions(null);
  };

  return (
    <div>
      <label>용어집</label>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 8px' }}>
        이름·지명 표기와 말투를 고정해요. 번역할 때 항상 이 표기를 써요.
      </p>
      {glossary.map((g) => (
        <div key={g.id} style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <input className="form-control" placeholder="영어 (예: Elise)" value={g.en} onChange={(e) => updateEntry(g.id, 'en', e.target.value)} />
            <input className="form-control" placeholder="한국어 (예: 엘리제)" value={g.ko} onChange={(e) => updateEntry(g.id, 'ko', e.target.value)} />
            <input className="form-control" placeholder="메모 (예: 반말, 차분한 말투)" value={g.note || ''} onChange={(e) => updateEntry(g.id, 'note', e.target.value)} />
          </div>
          <button className="btn danger" style={{ width: '44px', padding: '12px 0' }} onClick={() => deleteEntry(g.id)} aria-label="삭제">✕</button>
        </div>
      ))}

      {suggestions && suggestions.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '12px', margin: '8px 0' }}>
          <div style={{ fontWeight: 600, marginBottom: '8px' }}>추출된 용어</div>
          {suggestions.map((s) => (
            <label key={s.id} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontWeight: 400, marginBottom: '6px' }}>
              <input
                type="checkbox"
                checked={picked.has(s.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(s.id); else next.delete(s.id);
                  setPicked(next);
                }}
              />
              <span>{s.en} → {s.ko}{s.note ? <span style={{ color: 'var(--text-muted)' }}> ({s.note})</span> : null}</span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button className="btn secondary" onClick={() => setSuggestions(null)}>취소</button>
            <button className="btn" onClick={addPicked} disabled={!picked.size}>선택 추가</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        <button className="btn secondary" onClick={addEntry}>+ 용어 추가</button>
        {onSuggest && (
          <button className="btn secondary" onClick={runSuggest} disabled={loading}>
            {loading ? '추출 중…' : '자동 추출'}
          </button>
        )}
      </div>
    </div>
  );
}
