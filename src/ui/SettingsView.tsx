import { useEffect, useRef, useState } from 'react';
import { useAppContext } from './App';
import { db, isAbortError, modelInfo, defaultGenParams, KNOWN_TEXT_MODELS, type GenParams, type TextModelInfo } from '../core';
import { Eye, EyeOff } from 'lucide-react';

export function SettingsView() {
  const { settings, updateSettings, studio, showToast, isBusy, bumpData } = useAppContext();
  const [showKey, setShowKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [models, setModels] = useState<TextModelInfo[]>(KNOWN_TEXT_MODELS);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // When the key (or demo mode) changes, quietly load the model list and account info.
  // Debounced so typing a key doesn't fire a request per keystroke.
  useEffect(() => {
    const keyLooksComplete = settings.apiKey.startsWith('pst-') && settings.apiKey.length >= 40;
    if (!settings.mock && !keyLooksComplete) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      studio.listTextModels(ac.signal).then(setModels).catch(() => {});
      if (!settings.account) studio.verifyKey(ac.signal).then((account) => updateSettings({ account })).catch(() => {});
    }, 600);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [settings.apiKey, settings.mock]);

  const verifyKey = async () => {
    setChecking(true);
    try {
      const account = await studio.verifyKey();
      updateSettings({ account });
      showToast(`키 확인 완료 · ${account.tierName}`);
    } catch (e: any) {
      if (!isAbortError(e)) showToast(e.message);
    } finally {
      setChecking(false);
    }
  };

  const handleExport = async () => {
    try {
      const blob = await db.exportAll();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      a.href = url;
      a.download = `nai-studio-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      showToast(e.message);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const n = await db.importAll(file);
      bumpData();
      showToast(`가져왔어요: 소설 ${n.stories}, 대화 ${n.chats}, 이미지 ${n.images}`);
    } catch (err: any) {
      showToast(err.message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const current = models.find((m) => m.id === settings.textModel) ?? modelInfo(settings.textModel);
  const overrides = settings.genByModel[settings.textModel] ?? {};
  const defaults = defaultGenParams(settings.textModel);
  const value = <K extends keyof GenParams>(k: K) => overrides[k] ?? defaults[k];
  const setGen = (k: keyof GenParams, v: number) =>
    updateSettings({ genByModel: { ...settings.genByModel, [settings.textModel]: { ...overrides, [k]: v } } });
  const isChat = current.kind === 'chat';

  return (
    <div className="screen">
      <div className="header">
        <div style={{ width: '44px' }} />
        <h1>설정</h1>
        <div style={{ width: '44px' }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div className="page-form">
          {!settings.apiKey && !settings.mock && (
            <div className="welcome">
              <strong>NAI 스튜디오에 오신 걸 환영해요.</strong>
              <p>NovelAI API 키를 넣으면 소설·채팅·이미지를 쓸 수 있어요. 키 없이 둘러보려면 아래 데모 모드를 켜 보세요.</p>
            </div>
          )}

          <section className="card">
            <h2>NovelAI 계정</h2>
            <div className="form-group">
              <label>API 키</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    className="form-control"
                    type={showKey ? 'text' : 'password'}
                    value={settings.apiKey}
                    onChange={(e) => updateSettings({ apiKey: e.target.value.trim(), account: null })}
                    placeholder="pst-..."
                    autoComplete="off"
                    spellCheck={false}
                    style={{ paddingRight: '44px' }}
                  />
                  <button className="icon-in-input" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '키 숨기기' : '키 보기'}>
                    {showKey ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
                <button className="btn" style={{ width: 'auto', padding: '0 16px' }} onClick={verifyKey} disabled={checking || (!settings.apiKey && !settings.mock)}>
                  {checking ? '확인 중…' : '키 확인'}
                </button>
              </div>
              <p className="hint">NovelAI 웹 → 설정(⚙) → Account → "Get Persistent API Token" (pst-로 시작)</p>
            </div>

            {settings.account && (
              <div className="account">
                <strong>{settings.account.tierName}</strong>
                <span>Anlas {settings.account.anlas.toLocaleString()}</span>
                <span>만료 {settings.account.expiresAt ? new Date(settings.account.expiresAt).toLocaleDateString() : '없음'}</span>
              </div>
            )}

            <label className="check">
              <input type="checkbox" checked={settings.rememberKey} onChange={(e) => updateSettings({ rememberKey: e.target.checked })} />
              이 기기에 키 저장 (끄면 탭을 닫을 때 지워져요)
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.mock} onChange={(e) => updateSettings({ mock: e.target.checked, account: null })} />
              데모 모드 (키 없이 가짜 응답으로 체험)
            </label>
          </section>

          <section className="card">
            <h2>글쓰기</h2>
            <div className="form-group">
              <label>글쓰기 모델</label>
              <select className="form-control" value={settings.textModel} onChange={(e) => updateSettings({ textModel: e.target.value })}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              {current.note && <p className="hint">{current.note}</p>}
            </div>

            <div className="form-group">
              <label>출력 방식</label>
              <select className="form-control" value={settings.outputMode} onChange={(e) => updateSettings({ outputMode: e.target.value as typeof settings.outputMode })}>
                <option value="translate">영어로 쓰고 한국어로 번역 (추천)</option>
                <option value="direct-ko">한국어로 바로 쓰기 (GLM 계열만)</option>
                <option value="english">영어 그대로</option>
              </select>
              {settings.outputMode === 'direct-ko' && current.kind === 'completion' && (
                <p className="hint warn">{current.label}은(는) 한국어를 직접 쓸 수 없어서 번역 방식으로 동작해요.</p>
              )}
            </div>

            <div className="form-group">
              <label>창의성 (temperature) {value('temperature')}</label>
              <input type="range" min="0.1" max={isChat ? 1.25 : 2.5} step="0.01" value={value('temperature')} onChange={(e) => setGen('temperature', Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>출력 길이 (토큰) {value('maxTokens')}</label>
              <input type="range" min="20" max={current.maxOutputTokens} step="10" value={Math.min(value('maxTokens'), current.maxOutputTokens)} onChange={(e) => setGen('maxTokens', Number(e.target.value))} />
            </div>
            {isChat && (
              <div className="form-group">
                <label>top_p {value('topP')}</label>
                <input type="range" min="0.05" max="1" step="0.01" value={value('topP')} onChange={(e) => setGen('topP', Number(e.target.value))} />
              </div>
            )}
            {Object.keys(overrides).length > 0 && (
              <button
                className="btn secondary"
                onClick={() => {
                  const next = { ...settings.genByModel };
                  delete next[settings.textModel];
                  updateSettings({ genByModel: next });
                }}
              >
                기본값으로
              </button>
            )}

            <div className="form-group" style={{ marginTop: '16px' }}>
              <label>컨텍스트 길이 (글자 수, 0 = 자동)</label>
              <input className="form-control" type="number" min="0" step="1000" value={settings.contextChars} onChange={(e) => updateSettings({ contextChars: Math.max(0, Number(e.target.value) || 0) })} />
              <p className="hint">모델에 보내는 이전 내용의 양이에요. "입력이 너무 길다"는 오류가 나면 줄여 주세요.</p>
            </div>
          </section>

          <section className="card">
            <h2>번역</h2>
            <div className="form-group">
              <label>번역 모델</label>
              <select className="form-control" value={settings.translatorModel} onChange={(e) => updateSettings({ translatorModel: e.target.value })}>
                {models.filter((m) => m.kind === 'chat').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>번역 스타일</label>
              <textarea
                className="form-control"
                value={settings.translationStyle}
                onChange={(e) => updateSettings({ translationStyle: e.target.value })}
                placeholder="예: 소설체, 과거형 서술, 대사는 자연스러운 구어체"
                style={{ minHeight: '72px' }}
              />
            </div>
          </section>

          <section className="card">
            <h2>데이터</h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn secondary" onClick={handleExport} disabled={isBusy}>백업 내보내기</button>
              <button className="btn secondary" onClick={() => fileInputRef.current?.click()} disabled={isBusy}>백업 가져오기</button>
              <input type="file" ref={fileInputRef} style={{ display: 'none' }} accept=".json,application/json" onChange={handleImport} />
            </div>
            <p className="hint">소설·대화·이미지는 이 기기 브라우저에만 저장돼요. 백업 파일에 API 키는 들어가지 않아요.</p>
          </section>

          <p className="footer-note">API 키는 이 기기에만 저장되고 NovelAI 서버로만 전송돼요.</p>
        </div>
      </div>
    </div>
  );
}
