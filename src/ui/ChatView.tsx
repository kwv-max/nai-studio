import { useEffect, useRef, useState } from 'react';
import { useAppContext } from './App';
import { db, newChat, isAbortError, KNOWN_TEXT_MODELS, type Chat, type ChatMessage, type Progress } from '../core';
import { ActionSheet, GlossaryEditor, autoGrow, phaseLabel, sendOnEnter } from './Shared';
import { ChevronLeft, MoreVertical, Send, StopCircle } from 'lucide-react';

export function ChatView() {
  const { showToast, dataVersion } = useAppContext();
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [showNew, setShowNew] = useState(false);

  const loadChats = async () => {
    try {
      setChats(await db.listChats());
    } catch (e: any) {
      showToast(e.message);
    }
  };

  useEffect(() => {
    loadChats();
  }, [dataVersion]);

  if (activeChat) {
    return <ChatRoom key={activeChat.id} chat={activeChat} onBack={() => { setActiveChat(null); loadChats(); }} />;
  }

  if (showNew) {
    return <NewChatForm onCreated={(c) => { setActiveChat(c); setShowNew(false); }} onCancel={() => setShowNew(false)} />;
  }

  const handleDelete = async (id: string) => {
    if (confirm('이 대화를 삭제할까요? 되돌릴 수 없어요.')) {
      await db.deleteChat(id);
      loadChats();
    }
  };

  return (
    <div className="screen">
      <div className="header">
        <div style={{ width: '64px' }} />
        <h1>채팅</h1>
        <button className="header-btn" style={{ width: '64px' }} onClick={() => setShowNew(true)}>새 채팅</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {chats.length === 0 ? (
          <div className="empty">
            <p>아직 대화가 없어요.</p>
            <button className="btn" onClick={() => setShowNew(true)}>새 채팅 시작하기</button>
          </div>
        ) : (
          chats.map((c) => {
            const last = c.messages.at(-1);
            return (
              <div key={c.id} className="list-item" onClick={() => setActiveChat(c)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3>{c.charName || c.title}{c.charName && c.title !== c.charName ? <span className="muted"> · {c.title}</span> : null}</h3>
                  <p>{last ? (last.ko || last.en) : '내용 없음'}</p>
                </div>
                <button className="list-delete" onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }}>삭제</button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function NewChatForm({ onCreated, onCancel }: { onCreated: (c: Chat) => void; onCancel: () => void }) {
  const { showToast } = useAppContext();
  const [title, setTitle] = useState('');
  const [charName, setCharName] = useState('');
  const [userName, setUserName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [greeting, setGreeting] = useState('');
  const [model, setModel] = useState('');

  const handleCreate = async () => {
    try {
      const c = newChat({
        title: title.trim() || charName.trim() || '새 대화',
        charName: charName.trim(),
        userName: userName.trim(),
        systemPrompt,
        model: model || undefined,
        greeting,
      });
      await db.saveChat(c);
      onCreated(c);
    } catch (e: any) {
      showToast(e.message);
    }
  };

  return (
    <div className="screen">
      <div className="header">
        <button className="header-btn" onClick={onCancel} aria-label="뒤로"><ChevronLeft size={24} /></button>
        <h1>새 채팅</h1>
        <div style={{ width: '44px' }} />
      </div>
      <div className="page-form">
        <div className="form-group"><label>캐릭터 이름</label><input className="form-control" value={charName} placeholder="예: 엘리제" onChange={(e) => setCharName(e.target.value)} /></div>
        <div className="form-group"><label>내 이름 (선택)</label><input className="form-control" value={userName} placeholder="예: 카엘" onChange={(e) => setUserName(e.target.value)} /></div>
        <div className="form-group">
          <label>시스템 프롬프트 (캐릭터·상황 설정)</label>
          <textarea
            className="form-control"
            placeholder={'예:\n엘리제는 낡은 등대를 지키는 20대 여성이다. 무뚝뚝하지만 정이 많고, 반말을 쓴다.\n지금은 폭풍우 치는 밤, 오랜만에 돌아온 소꿉친구를 맞이하는 장면이다.'}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            style={{ minHeight: '140px' }}
          />
        </div>
        <div className="form-group">
          <label>첫 메시지 (선택)</label>
          <textarea className="form-control" placeholder="캐릭터가 먼저 건네는 말" value={greeting} onChange={(e) => setGreeting(e.target.value)} />
        </div>
        <div className="form-group"><label>대화 제목 (선택)</label><input className="form-control" value={title} placeholder="비우면 캐릭터 이름을 써요" onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="form-group">
          <label>모델</label>
          <select className="form-control" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">기본 설정 따름</option>
            {KNOWN_TEXT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <button className="btn" onClick={handleCreate} disabled={!charName.trim()}>대화 시작</button>
      </div>
    </div>
  );
}

function ChatRoom({ chat: initialChat, onBack }: { chat: Chat; onBack: () => void }) {
  const { studio, settings, isBusy, setBusy, showToast, navigate, setImageDraftText } = useAppContext();
  const [chat, setChat] = useState<Chat>(initialChat);
  const chatRef = useRef(chat);
  const [showSettings, setShowSettings] = useState(false);
  const [inputText, setInputText] = useState('');
  const abortCtrlRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);

  const [actionMsg, setActionMsg] = useState<ChatMessage | null>(null);
  const [editMsgId, setEditMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editField, setEditField] = useState<'ko' | 'en'>('ko');
  const [showEnMsgIds, setShowEnMsgIds] = useState<Set<string>>(new Set());

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const writeKo = studio.effectiveMode(chat.model || settings.textModel) === 'direct-ko';

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [progress, chat.messages.length]);

  useEffect(() => autoGrow(inputRef.current), [inputText]);

  const save = (c: Chat) => {
    chatRef.current = c;
    setChat(c);
    db.saveChat(c).catch((e) => showToast(e.message));
  };

  /** Generation results only replace messages; settings edited meanwhile are kept. */
  const applyResult = (next: Chat) => {
    save({ ...chatRef.current, messages: next.messages, cache: next.cache, updatedAt: next.updatedAt });
  };

  const handleStop = () => abortCtrlRef.current?.abort();

  const run = async (call: (c: Chat, signal: AbortSignal, onProgress: (p: Progress) => void) => Promise<Chat>): Promise<boolean> => {
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
      applyResult(await call(chatRef.current, ctrl.signal, setProgress));
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
    if (!text) return;
    setInputText('');
    let delivered = false;
    await run((c, signal, onProgress) =>
      studio.sendChat(c, text, {
        signal,
        onProgress,
        onUserMessage: (withUser) => {
          delivered = true;
          applyResult(withUser);
        },
      }),
    );
    // Give the text back only if it never made it into the chat.
    if (!delivered) setInputText((cur) => cur || text);
  };

  const handleContinue = () => run((c, signal, onProgress) => studio.generateReply(c, { signal, onProgress }));

  const handleRegenerate = () => {
    setActionMsg(null);
    run((c, signal, onProgress) => studio.regenerateReply(c, { signal, onProgress }));
  };

  const handleRetranslate = (id: string) => {
    setActionMsg(null);
    run((c, signal, onProgress) => studio.retranslateMessage(c, id, { signal, onProgress }));
  };

  const handleEdit = () => {
    if (!actionMsg) return;
    const field = showEnMsgIds.has(actionMsg.id) || !actionMsg.ko ? 'en' : 'ko';
    setEditField(field);
    setEditText(actionMsg[field]);
    setEditMsgId(actionMsg.id);
    setActionMsg(null);
  };

  const saveEdit = () => {
    const id = editMsgId;
    if (!id) return;
    setEditMsgId(null);
    run((c, signal, onProgress) => studio.editMessage(c, id, editField === 'en' ? { en: editText } : { ko: editText }, { signal, onProgress }));
  };

  const handleDeleteMsg = (id: string) => {
    setActionMsg(null);
    if (!confirm('이 메시지를 삭제할까요?')) return;
    save({ ...chatRef.current, messages: chatRef.current.messages.filter((m) => m.id !== id), updatedAt: Date.now() });
  };

  const toggleEn = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setShowEnMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const drawMsg = (msg: ChatMessage) => {
    setActionMsg(null);
    setImageDraftText(msg.en || msg.ko);
    navigate('image');
  };

  const lastMsg = chat.messages.at(-1);

  return (
    <div className="screen">
      <div className="header">
        <button className="header-btn" onClick={onBack} aria-label="뒤로"><ChevronLeft size={24} /></button>
        <div style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
          <div className="header-title">{chat.charName || chat.title}</div>
          {chat.charName && chat.title !== chat.charName && <div className="header-sub">{chat.title}</div>}
        </div>
        <button className="header-btn" onClick={() => setShowSettings(true)} aria-label="대화 설정"><MoreVertical size={24} /></button>
      </div>

      <div className="chat-messages">
        {chat.messages.length === 0 && !progress && (
          <div className="empty"><p>첫 메시지를 보내 대화를 시작해 보세요.</p></div>
        )}
        {chat.messages.map((msg) => {
          if (editMsgId === msg.id) {
            return (
              <div key={msg.id} className="edit-box" style={{ margin: '8px 16px' }}>
                <textarea className="form-control" value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn secondary" onClick={() => setEditMsgId(null)}>취소</button>
                  <button className="btn" onClick={saveEdit}>저장</button>
                </div>
              </div>
            );
          }
          const isEn = showEnMsgIds.has(msg.id);
          const hasBoth = Boolean(msg.en && msg.ko);
          return (
            <div key={msg.id} className={`chat-bubble ${msg.role} ${actionMsg?.id === msg.id ? 'selected' : ''}`} onClick={() => setActionMsg(msg)}>
              <div className="bubble-text">{isEn ? msg.en : msg.ko || msg.en}</div>
              {hasBoth && (
                <button className="bubble-toggle" onClick={(e) => toggleEn(msg.id, e)}>
                  {isEn ? '한국어 보기' : '원문 보기'}
                </button>
              )}
            </div>
          );
        })}
        {progress && running && (
          <div className="chat-bubble assistant live">
            <span className="phase-badge">{phaseLabel(progress, writeKo)}</span>
            <div className="bubble-text">
              {progress.phase === 'generating' && !writeKo ? <span className="segment-en">{progress.en}</span> : progress.ko || progress.en}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="composer-row">
          <textarea
            ref={inputRef}
            className="form-control"
            rows={1}
            placeholder="메시지 입력"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => sendOnEnter(e, handleSend)}
          />
          {running ? (
            <button className="btn danger" onClick={handleStop} aria-label="중지"><StopCircle size={24} /></button>
          ) : (
            <button className="btn" onClick={handleSend} disabled={isBusy || !inputText.trim()} aria-label="보내기"><Send size={24} /></button>
          )}
        </div>
        <button className="btn ghost" onClick={handleContinue} disabled={isBusy}>입력 없이 계속 말하게 하기</button>
      </div>

      <ActionSheet isOpen={!!actionMsg} onClose={() => setActionMsg(null)}>
        <div className="sheet-actions">
          {actionMsg && actionMsg.id === lastMsg?.id && actionMsg.role === 'assistant' && (
            <button className="btn" onClick={handleRegenerate} disabled={isBusy}>다시 생성</button>
          )}
          <button className="btn secondary" onClick={handleEdit}>수정</button>
          {actionMsg?.en && actionMsg.role === 'assistant' && (
            <button className="btn secondary" onClick={() => actionMsg && handleRetranslate(actionMsg.id)} disabled={isBusy}>다시 번역</button>
          )}
          <button className="btn secondary" onClick={() => actionMsg && drawMsg(actionMsg)}>이 장면 그리기</button>
          <button className="btn danger" onClick={() => actionMsg && handleDeleteMsg(actionMsg.id)}>삭제</button>
        </div>
      </ActionSheet>

      <ActionSheet isOpen={showSettings} onClose={() => setShowSettings(false)}>
        <div className="sheet-form">
          <h2 className="sheet-title">대화 설정</h2>
          <div className="form-group">
            <label>대화 제목</label>
            <input className="form-control" value={chat.title} onChange={(e) => save({ ...chat, title: e.target.value })} />
          </div>
          <div className="form-group">
            <label>캐릭터 이름</label>
            <input className="form-control" value={chat.charName} onChange={(e) => save({ ...chat, charName: e.target.value })} />
          </div>
          <div className="form-group">
            <label>내 이름</label>
            <input className="form-control" value={chat.userName} onChange={(e) => save({ ...chat, userName: e.target.value })} />
          </div>
          <div className="form-group">
            <label>시스템 프롬프트</label>
            <textarea className="form-control" value={chat.systemPrompt} onChange={(e) => save({ ...chat, systemPrompt: e.target.value })} style={{ minHeight: '120px' }} />
          </div>
          <GlossaryEditor
            glossary={chat.glossary}
            onChange={(g) => save({ ...chat, glossary: g })}
            onSuggest={() => studio.suggestGlossary(chat.messages.map((m) => m.en).filter(Boolean).join('\n\n'), chat.glossary)}
            onError={showToast}
          />
          <div className="form-group">
            <label>모델</label>
            <select className="form-control" value={chat.model || ''} onChange={(e) => save({ ...chat, model: e.target.value || undefined })}>
              <option value="">기본 설정 따름</option>
              {KNOWN_TEXT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          {chat.messages.some((m) => m.en && !m.ko && m.role === 'assistant') && (
            <button
              className="btn secondary"
              disabled={isBusy}
              onClick={() => {
                setShowSettings(false);
                run((c, signal, onProgress) => studio.fillMissingKorean(c, { signal, onProgress }));
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
