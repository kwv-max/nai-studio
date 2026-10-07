import { useEffect, useRef, useState } from 'react';
import { useAppContext } from './App';
import { db, newStory, isAbortError, KNOWN_TEXT_MODELS, type Progress, type Segment, type Story } from '../core';
import { ActionSheet, GlossaryEditor, autoGrow, imageReference, phaseLabel, sendOnEnter } from './Shared';
import { ChevronLeft, MoreVertical, Send, StopCircle } from 'lucide-react';

export function NovelView() {
  const { showToast, dataVersion } = useAppContext();
  const [stories, setStories] = useState<Story[]>([]);
  const [activeStory, setActiveStory] = useState<Story | null>(null);

  const loadStories = async () => {
    try {
      setStories(await db.listStories());
    } catch (e: any) {
      showToast(e.message);
    }
  };

  useEffect(() => {
    loadStories();
  }, [dataVersion]);

  if (activeStory) {
    return <NovelEditor key={activeStory.id} story={activeStory} onBack={() => { setActiveStory(null); loadStories(); }} />;
  }

  const handleNewStory = async () => {
    const s = newStory({ title: '새 소설' });
    await db.saveStory(s);
    setActiveStory(s);
  };

  const handleDelete = async (id: string) => {
    if (confirm('이 소설을 삭제할까요? 되돌릴 수 없어요.')) {
      await db.deleteStory(id);
      loadStories();
    }
  };

  return (
    <div className="screen">
      <div className="header">
        <div style={{ width: '64px' }} />
        <h1>소설</h1>
        <button className="header-btn" style={{ width: '64px' }} onClick={handleNewStory}>새 소설</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {stories.length === 0 ? (
          <div className="empty">
            <p>아직 소설이 없어요.</p>
            <button className="btn" onClick={handleNewStory}>새 소설 시작하기</button>
          </div>
        ) : (
          stories.map((s) => {
            const last = s.segments.at(-1);
            return (
              <div key={s.id} className="list-item" onClick={() => setActiveStory(s)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3>{s.title}</h3>
                  <p>{last ? (last.ko || last.en).trim() : '내용 없음'}</p>
                </div>
                <button className="list-delete" onClick={(e) => { e.stopPropagation(); handleDelete(s.id); }}>삭제</button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function NovelEditor({ story: initialStory, onBack }: { story: Story; onBack: () => void }) {
  const { studio, settings, isBusy, setBusy, showToast, navigate, setImageDraft } = useAppContext();
  const [story, setStory] = useState<Story>(initialStory);
  const storyRef = useRef(story);
  const [showSettings, setShowSettings] = useState(false);
  const [inputMode, setInputMode] = useState<'instruct' | 'write'>('instruct');
  const [inputText, setInputText] = useState('');
  const [viewMode, setViewMode] = useState<'ko' | 'en' | 'both'>('ko');
  const abortCtrlRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);

  const [actionSegment, setActionSegment] = useState<Segment | null>(null);
  const [editSegmentId, setEditSegmentId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editField, setEditField] = useState<'ko' | 'en'>('ko');

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const model = story.model || settings.textModel;
  const writeKo = studio.effectiveMode(model) === 'direct-ko';

  useEffect(() => {
    if (progress) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [progress, story.segments.length]);

  useEffect(() => autoGrow(inputRef.current), [inputText]);

  /** Updates state immediately (so typing never lags) and persists in the background. */
  const save = (s: Story) => {
    storyRef.current = s;
    setStory(s);
    db.saveStory(s).catch((e) => showToast(e.message));
  };

  /** Generation results only replace content; settings edited meanwhile are kept. */
  const applyResult = (next: Story) => {
    save({ ...storyRef.current, segments: next.segments, cache: next.cache, updatedAt: next.updatedAt });
  };

  const handleStop = () => abortCtrlRef.current?.abort();

  const run = async (call: (s: Story, signal: AbortSignal, onProgress: (p: Progress) => void) => Promise<Story>): Promise<boolean> => {
    if (isBusy) {
      showToast('다른 생성이 진행 중이에요.');
      return false;
    }
    setBusy(true);
    setRunning(true);
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    setProgress({ phase: 'preparing', en: '', ko: '' });
    try {
      applyResult(await call(storyRef.current, ctrl.signal, setProgress));
      return true;
    } catch (e: any) {
      if (!isAbortError(e)) showToast(e.message);
      return false;
    } finally {
      setBusy(false);
      setRunning(false);
      setProgress(null);
      abortCtrlRef.current = null;
    }
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (inputMode === 'write' && !text) return;
    setInputText('');
    const ok =
      inputMode === 'write'
        ? await run((s, signal, onProgress) => studio.addUserText(s, text, { signal, onProgress }))
        : await run((s, signal, onProgress) => studio.continueStory(s, { instruction: text || undefined, signal, onProgress }));
    if (!ok) setInputText((cur) => cur || text);
  };

  const handleReroll = () => {
    setActionSegment(null);
    run((s, signal, onProgress) => studio.rerollStory(s, { signal, onProgress }));
  };

  const handleRetranslate = (segId: string) => {
    setActionSegment(null);
    run((s, signal, onProgress) => studio.retranslateSegment(s, segId, { signal, onProgress }));
  };

  const handleEdit = () => {
    if (!actionSegment) return;
    const field = viewMode === 'en' || !actionSegment.ko ? 'en' : 'ko';
    setEditField(field);
    setEditText(actionSegment[field].trim());
    setEditSegmentId(actionSegment.id);
    setActionSegment(null);
  };

  const saveEdit = () => {
    const id = editSegmentId;
    if (!id) return;
    setEditSegmentId(null);
    run((s, signal, onProgress) => studio.editSegment(s, id, editField === 'en' ? { en: editText } : { ko: editText }, { signal, onProgress }));
  };

  const handleDeleteSegment = (id: string) => {
    setActionSegment(null);
    if (!confirm('이 문단을 삭제할까요?')) return;
    save({ ...storyRef.current, segments: storyRef.current.segments.filter((s) => s.id !== id), updatedAt: Date.now() });
  };

  const drawSegment = (seg: Segment) => {
    setActionSegment(null);
    setImageDraft({ text: seg.en || seg.ko, display: seg.ko || seg.en, reference: imageReference(storyRef.current), source: storyRef.current.title });
    navigate('image');
  };

  const lastSeg = story.segments.at(-1);
  const segText = (seg: Segment) => (viewMode === 'en' ? seg.en || seg.ko : seg.ko || seg.en);

  return (
    <div className="screen">
      <div className="header">
        <button className="header-btn" onClick={onBack} aria-label="뒤로"><ChevronLeft size={24} /></button>
        <input
          className="title-input"
          value={story.title}
          onChange={(e) => save({ ...story, title: e.target.value, updatedAt: Date.now() })}
          aria-label="제목"
        />
        <button className="header-btn" onClick={() => setShowSettings(true)} aria-label="소설 설정"><MoreVertical size={24} /></button>
      </div>

      <div className="segmented">
        {(['ko', 'en', 'both'] as const).map((m) => (
          <button key={m} className={viewMode === m ? 'on' : ''} onClick={() => setViewMode(m)}>
            {m === 'ko' ? '한국어' : m === 'en' ? '원문' : '함께 보기'}
          </button>
        ))}
      </div>

      <div className="prose story-body">
        {story.segments.length === 0 && !progress && (
          <div className="empty" style={{ fontFamily: 'var(--sans)' }}>
            <p>오른쪽 위 ⋮ 에서 시스템 프롬프트(세계관·인물·문체)를 적고,<br />아래에서 이어쓰기를 눌러 보세요.</p>
          </div>
        )}

        {viewMode === 'both' ? (
          story.segments.map((seg) =>
            editSegmentId === seg.id ? (
              <EditBox key={seg.id} value={editText} onChange={setEditText} onCancel={() => setEditSegmentId(null)} onSave={saveEdit} field={editField} writeKo={writeKo} />
            ) : (
              <div key={seg.id} className={`segment ${actionSegment?.id === seg.id ? 'selected' : ''}`} onClick={() => setActionSegment(seg)}>
                <div>{(seg.ko || seg.en).trim()}</div>
                {seg.ko && seg.en && <div className="segment-en">{seg.en.trim()}</div>}
              </div>
            ),
          )
        ) : (
          <div className="flow">
            {story.segments.map((seg) =>
              editSegmentId === seg.id ? (
                <EditBox key={seg.id} value={editText} onChange={setEditText} onCancel={() => setEditSegmentId(null)} onSave={saveEdit} field={editField} writeKo={writeKo} />
              ) : (
                <span
                  key={seg.id}
                  className={`seg ${seg.author === 'user' ? 'by-user' : ''} ${actionSegment?.id === seg.id ? 'selected' : ''}`}
                  onClick={() => setActionSegment(seg)}
                >
                  {segText(seg)}
                </span>
              ),
            )}
          </div>
        )}

        {progress && running && (
          <div className="live-block">
            <span className="phase-badge">{phaseLabel(progress, writeKo)}</span>
            {progress.phase === 'generating' && !writeKo ? (
              <div className="segment-en">{progress.en.trim()}</div>
            ) : (
              <div>{(progress.ko || progress.en).trim()}</div>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="segmented compact">
          <button className={inputMode === 'instruct' ? 'on' : ''} onClick={() => setInputMode('instruct')}>AI에게 지시</button>
          <button className={inputMode === 'write' ? 'on' : ''} onClick={() => setInputMode('write')}>직접 쓰기</button>
        </div>
        <div className="composer-row">
          <textarea
            ref={inputRef}
            className="form-control"
            rows={1}
            placeholder={inputMode === 'instruct' ? '다음 전개 지시 (비우면 그냥 이어써요)' : '이어질 내용을 직접 써 주세요'}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => sendOnEnter(e, handleSend)}
          />
          {running ? (
            <button className="btn danger" onClick={handleStop} aria-label="중지"><StopCircle size={24} /></button>
          ) : (
            <button
              className="btn"
              onClick={handleSend}
              disabled={isBusy || (inputMode === 'write' && !inputText.trim())}
              aria-label={inputMode === 'instruct' ? '이어쓰기' : '추가'}
            >
              <Send size={24} />
            </button>
          )}
        </div>
      </div>

      <ActionSheet isOpen={!!actionSegment} onClose={() => setActionSegment(null)}>
        <div className="sheet-actions">
          {actionSegment && actionSegment.id === lastSeg?.id && actionSegment.author === 'ai' && (
            <button className="btn" onClick={handleReroll} disabled={isBusy}>다시 쓰기</button>
          )}
          <button className="btn secondary" onClick={handleEdit}>수정</button>
          {actionSegment?.en && (
            <button className="btn secondary" onClick={() => actionSegment && handleRetranslate(actionSegment.id)} disabled={isBusy}>다시 번역</button>
          )}
          <button className="btn secondary" onClick={() => actionSegment && drawSegment(actionSegment)}>이 장면 그리기</button>
          <button className="btn danger" onClick={() => actionSegment && handleDeleteSegment(actionSegment.id)}>삭제</button>
        </div>
      </ActionSheet>

      <ActionSheet isOpen={showSettings} onClose={() => setShowSettings(false)}>
        <div className="sheet-form">
          <h2 className="sheet-title">소설 설정</h2>
          <div className="form-group">
            <label>시스템 프롬프트 (메모리)</label>
            <textarea
              className="form-control"
              value={story.systemPrompt}
              placeholder="세계관, 등장인물, 문체 등. 예: 비 내리는 항구 도시를 배경으로 한 미스터리. 주인공 엘리제는 등대지기의 딸이다."
              onChange={(e) => save({ ...story, systemPrompt: e.target.value })}
              style={{ minHeight: '120px' }}
            />
          </div>
          <div className="form-group">
            <label>작가 노트</label>
            <textarea
              className="form-control"
              value={story.authorsNote}
              placeholder="지금 장면에 대한 짧은 방향. 예: 긴장감 있게, 대화 위주로"
              onChange={(e) => save({ ...story, authorsNote: e.target.value })}
              style={{ minHeight: '60px' }}
            />
          </div>
          <GlossaryEditor
            glossary={story.glossary}
            onChange={(g) => save({ ...story, glossary: g })}
            onSuggest={() => studio.suggestGlossary(story.segments.map((s) => s.en).join(''), story.glossary)}
            onError={showToast}
          />
          <div className="form-group">
            <label>모델</label>
            <select className="form-control" value={story.model || ''} onChange={(e) => save({ ...story, model: e.target.value || undefined })}>
              <option value="">기본 설정 따름</option>
              {KNOWN_TEXT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          {story.segments.some((s) => s.en && !s.ko) && (
            <button
              className="btn secondary"
              disabled={isBusy}
              onClick={() => {
                setShowSettings(false);
                run((s, signal, onProgress) => studio.fillMissingKorean(s, { signal, onProgress }));
              }}
            >
              빠진 번역 채우기
            </button>
          )}
          <button className="btn" onClick={() => setShowSettings(false)}>닫기</button>
        </div>
      </ActionSheet>
    </div>
  );
}

function EditBox({ value, onChange, onCancel, onSave, field, writeKo }: {
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
  field: 'ko' | 'en';
  writeKo: boolean;
}) {
  return (
    <div className="edit-box">
      <textarea className="form-control" value={value} onChange={(e) => onChange(e.target.value)} autoFocus />
      {!writeKo && <p className="hint">{field === 'ko' ? '저장하면 영어 원문도 새로 번역돼요.' : '저장하면 한국어 번역도 새로 만들어요.'}</p>}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="btn secondary" onClick={onCancel}>취소</button>
        <button className="btn" onClick={onSave}>저장</button>
      </div>
    </div>
  );
}
