import { useEffect, useRef, useState } from 'react';
import { useAppContext } from './App';
import {
  db,
  CHARACTER_POSITIONS,
  IMAGE_MODELS,
  IMAGE_SIZES,
  IMAGE_SAMPLERS,
  imageCost,
  imageModelInfo,
  isAbortError,
  type CharacterPrompt,
  type GalleryImage,
  type ImageSettings,
} from '../core';
import { newId } from './Shared';
import { ChevronLeft, ChevronDown, ChevronUp, Download, Share2, Trash2, RefreshCcw, Plus, X } from 'lucide-react';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
const fileName = (img: GalleryImage) => `nai-${img.seed}.${EXT[img.mime] ?? 'png'}`;

/** Character card in the editor; `key` keeps React rows stable while editing. */
type CharacterRow = CharacterPrompt & { key: string };
const toRows = (list: CharacterPrompt[] = []): CharacterRow[] => list.map((c) => ({ ...c, key: newId() }));
const fromRows = (rows: CharacterRow[]): CharacterPrompt[] => rows.map(({ key: _key, ...c }) => c);

/** Object URL tied to the component's lifetime. */
function useBlobUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function Thumb({ img, onClick }: { img: GalleryImage; onClick: () => void }) {
  const url = useBlobUrl(img.blob);
  return (
    <button className="gallery-item" onClick={onClick} aria-label={img.prompt}>
      {url && <img src={url} alt="" loading="lazy" />}
    </button>
  );
}

export function ImageView() {
  const { settings, updateSettings, studio, showToast, isBusy, setBusy, imageDraft, setImageDraft, dataVersion } = useAppContext();
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState<{ text: string; source: string } | null>(null);
  const [base, setBase] = useState('');
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [task, setTask] = useState<'tags' | 'image' | null>(null);
  const [showOptions, setShowOptions] = useState(false);

  const [images, setImages] = useState<GalleryImage[]>([]);
  const [activeImage, setActiveImage] = useState<GalleryImage | null>(null);
  const activeUrl = useBlobUrl(activeImage?.blob);

  const abortCtrlRef = useRef<AbortController | null>(null);
  const info = imageModelInfo(settings.image.model);
  const cost = imageCost(settings);
  const canAddCharacter = info.maxCharacters > 0 && characters.length < info.maxCharacters;

  const loadImages = async () => {
    try {
      setImages(await db.listImages());
    } catch (e: any) {
      showToast(e.message);
    }
  };

  useEffect(() => {
    loadImages();
  }, [dataVersion]);

  const begin = (t: 'tags' | 'image') => {
    if (isBusy) {
      showToast('다른 생성이 진행 중이에요.');
      return null;
    }
    setBusy(true);
    setTask(t);
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    return ctrl;
  };

  const end = () => {
    setBusy(false);
    setTask(null);
    abortCtrlRef.current = null;
  };

  const convertToTags = async (text: string, fromStory: boolean, ref?: string) => {
    if (!text.trim()) return;
    const ctrl = begin('tags');
    if (!ctrl) return;
    setBase('');
    setCharacters([]);
    try {
      const result = await studio.textToTags(text, { fromStory, reference: ref, signal: ctrl.signal, onText: setBase });
      setBase(result.base);
      setCharacters(toRows(result.characters));
    } catch (e: any) {
      if (!isAbortError(e)) showToast(e.message);
    } finally {
      end();
    }
  };

  // "이 장면 그리기" from the novel or chat tab.
  useEffect(() => {
    if (!imageDraft) return;
    const draft = imageDraft;
    setImageDraft(null);
    setActiveImage(null);
    setDescription(draft.display.trim());
    const ref = draft.reference.trim() ? { text: draft.reference, source: draft.source } : null;
    setReference(ref);
    convertToTags(draft.text, true, ref?.text);
  }, [imageDraft]);

  const handleGenerate = async () => {
    if (!base.trim() && !characters.some((c) => c.prompt.trim())) return;
    const ctrl = begin('image');
    if (!ctrl) return;
    try {
      const img = await studio.generateImage(
        { prompt: base, characters: fromRows(characters), sourceKo: description.trim() || undefined },
        ctrl.signal,
      );
      await db.saveImage(img);
      setImages((prev) => [img, ...prev]);
      setActiveImage(img);
    } catch (e: any) {
      if (!isAbortError(e)) showToast(e.message);
    } finally {
      end();
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('이 이미지를 삭제할까요?')) return;
    await db.deleteImage(id);
    setActiveImage(null);
    setImages((prev) => prev.filter((i) => i.id !== id));
  };

  const handleDownload = (img: GalleryImage) => {
    const url = URL.createObjectURL(img.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(img);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleShare = async (img: GalleryImage) => {
    const file = new File([img.blob], fileName(img), { type: img.mime });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch {
        // cancelled
      }
    } else {
      handleDownload(img);
    }
  };

  const setImage = (patch: Partial<ImageSettings>) => updateSettings({ image: { ...settings.image, ...patch } });

  /** Switching models also moves scale/steps/negative prompt to the new model's defaults, unless the user changed them. */
  const changeModel = (id: string) => {
    const next = imageModelInfo(id);
    const prev = info;
    const s = settings.image;
    setImage({
      model: id,
      ...(s.negativePrompt === prev.defaultNegative ? { negativePrompt: next.defaultNegative } : {}),
      ...(s.scale === prev.defaults.scale ? { scale: next.defaults.scale } : {}),
      ...(s.steps === prev.defaults.steps ? { steps: next.defaults.steps } : {}),
    });
  };

  const updateCharacter = (key: string, patch: Partial<CharacterPrompt>) =>
    setCharacters((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  if (activeImage) {
    return (
      <div className="screen viewer">
        <div className="header viewer-header">
          <button className="header-btn" onClick={() => setActiveImage(null)} aria-label="뒤로"><ChevronLeft size={24} /></button>
          <div style={{ flex: 1 }} />
          <button className="header-btn" onClick={() => handleDownload(activeImage)} aria-label="저장"><Download size={22} /></button>
          <button className="header-btn" onClick={() => handleShare(activeImage)} aria-label="공유"><Share2 size={22} /></button>
          <button className="header-btn danger-text" onClick={() => handleDelete(activeImage.id)} aria-label="삭제"><Trash2 size={22} /></button>
        </div>
        <div className="viewer-image">
          {activeUrl && <img src={activeUrl} alt={activeImage.prompt} />}
        </div>
        <div className="viewer-info">
          <p className="muted">시드 {activeImage.seed} · {imageModelInfo(activeImage.model).label} · {activeImage.width}×{activeImage.height}</p>
          {activeImage.sourceKo && <p className="viewer-ko">{activeImage.sourceKo}</p>}
          <p className="viewer-prompt">{activeImage.prompt}</p>
          {activeImage.characters?.map((c, i) => (
            <p key={i} className="viewer-prompt"><span className="viewer-ko">{c.name || `캐릭터 ${i + 1}`}</span> · {c.prompt}</p>
          ))}
          <button
            className="btn secondary"
            onClick={() => {
              setBase(activeImage.prompt);
              setCharacters(toRows(activeImage.characters));
              setDescription(activeImage.sourceKo ?? '');
              setImage({ seed: activeImage.seed });
              setActiveImage(null);
              showToast('프롬프트와 시드를 불러왔어요. 시드를 −1로 바꾸면 다시 랜덤이에요.');
            }}
          >
            <RefreshCcw size={16} style={{ verticalAlign: 'text-bottom', marginRight: '8px' }} />
            같은 프롬프트·시드로 다시
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="header">
        <div className="header-side" />
        <h1>이미지</h1>
        <div className="header-side" style={{ justifyContent: 'flex-end' }}>
          <span className={`cost-badge ${cost.free ? 'free' : 'paid'}`}>{cost.label}</span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div className="page-form">
          <div className="form-group">
            <label>묘사 (한국어)</label>
            <textarea
              className="form-control"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="예: 해질녘 교실, 창가에 앉은 단발 소녀에게 남학생이 우산을 건넨다"
              style={{ minHeight: '72px' }}
            />
            {reference && (
              <div className="ref-chip">
                <span>‘{reference.source}’ 설정의 인물 외형을 참고해요</span>
                <button onClick={() => setReference(null)} aria-label="참고 끄기"><X size={14} /></button>
              </div>
            )}
            <button
              className="btn secondary"
              style={{ marginTop: '8px' }}
              onClick={() => (task === 'tags' ? abortCtrlRef.current?.abort() : convertToTags(description, Boolean(reference), reference?.text))}
              disabled={task === 'image' || (task !== 'tags' && (isBusy || !description.trim()))}
            >
              {task === 'tags' ? '변환 중… (눌러서 중지)' : '태그로 변환 ↓'}
            </button>
          </div>

          <div className="form-group">
            <label>장면·구도 (기본 프롬프트)</label>
            <textarea
              className="form-control mono"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="1girl, 1boy, classroom, sunset, window, cowboy shot"
              style={{ minHeight: '96px' }}
            />
          </div>

          {(characters.length > 0 || info.maxCharacters > 0) && (
            <div className="form-group">
              <label>
                캐릭터 <span className="muted">· 인물마다 따로 적으면 특징이 섞이지 않아요</span>
              </label>
              {characters.map((c, i) => (
                <div key={c.key} className="char-card">
                  <div className="char-card-head">
                    <input
                      className="char-name"
                      value={c.name}
                      placeholder={`캐릭터 ${i + 1}`}
                      onChange={(e) => updateCharacter(c.key, { name: e.target.value })}
                      aria-label="캐릭터 이름 (메모용)"
                    />
                    <select className="char-pos" value={c.position} onChange={(e) => updateCharacter(c.key, { position: e.target.value })} aria-label="위치">
                      {CHARACTER_POSITIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                    <button className="char-del" onClick={() => setCharacters((rows) => rows.filter((r) => r.key !== c.key))} aria-label="캐릭터 삭제"><X size={18} /></button>
                  </div>
                  <textarea
                    className="form-control mono"
                    value={c.prompt}
                    onChange={(e) => updateCharacter(c.key, { prompt: e.target.value })}
                    placeholder="girl, short hair, black hair, school uniform, smile, source#hug"
                    style={{ minHeight: '64px' }}
                  />
                </div>
              ))}
              {info.maxCharacters === 0 ? (
                characters.length > 0 && <p className="hint warn">{info.label}은(는) 캐릭터 프롬프트가 없어서 기본 프롬프트에 합쳐 보내요.</p>
              ) : (
                <button
                  className="btn ghost add-char"
                  onClick={() => setCharacters((rows) => [...rows, { key: newId(), name: '', prompt: '', position: 'auto' }])}
                  disabled={!canAddCharacter}
                >
                  <Plus size={16} /> 캐릭터 추가
                </button>
              )}
              <p className="hint">
                두 명 이상일 때 써요. 상호작용은 하는 쪽에 <code>source#hug</code>, 받는 쪽에 <code>target#hug</code>, 서로 하면 둘 다 <code>mutual#holding hands</code>.
              </p>
            </div>
          )}

          {task === 'image' ? (
            <button className="btn danger" onClick={() => abortCtrlRef.current?.abort()}>생성 중… (눌러서 중지)</button>
          ) : (
            <button className="btn" onClick={handleGenerate} disabled={isBusy || (!base.trim() && !characters.some((c) => c.prompt.trim()))}>
              이미지 생성
            </button>
          )}

          <div className="options">
            <button className="options-toggle" onClick={() => setShowOptions(!showOptions)}>
              <span>옵션 <span className="muted">· {info.label} · {settings.image.width}×{settings.image.height}</span></span>
              {showOptions ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            </button>

            {showOptions && (
              <div className="options-body">
                <div>
                  <label>모델</label>
                  <select className="form-control" value={settings.image.model} onChange={(e) => changeModel(e.target.value)}>
                    {IMAGE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  {info.family === 'v5' && (
                    <p className="hint">V5는 Opus도 무제한이 아니라 천천히 충전되는 한도를 써요. 한도를 넘으면 Anlas가 들어요.</p>
                  )}
                </div>

                <div>
                  <label>크기</label>
                  <div className="chips">
                    {IMAGE_SIZES.map((s) => (
                      <button
                        key={`${s.width}x${s.height}`}
                        className={settings.image.width === s.width && settings.image.height === s.height ? 'on' : ''}
                        onClick={() => setImage({ width: s.width, height: s.height })}
                      >
                        {s.label} <span className="muted">{s.width}×{s.height}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label>스텝 {settings.image.steps}{settings.image.steps > 28 ? ' (28 초과: Anlas 소모)' : ''}</label>
                  <input type="range" min="1" max="50" value={settings.image.steps} onChange={(e) => setImage({ steps: Number(e.target.value) })} />
                </div>

                <div>
                  <label>가이던스 {settings.image.scale}</label>
                  <input type="range" min="1" max="10" step="0.1" value={settings.image.scale} onChange={(e) => setImage({ scale: Number(e.target.value) })} />
                </div>

                <div>
                  <label>샘플러</label>
                  <select className="form-control" value={settings.image.sampler} onChange={(e) => setImage({ sampler: e.target.value })}>
                    {IMAGE_SAMPLERS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>

                <div>
                  <label>시드 (−1 = 랜덤)</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input type="number" className="form-control" value={settings.image.seed} onChange={(e) => setImage({ seed: Math.trunc(Number(e.target.value)) || -1 })} />
                    <button className="btn secondary" style={{ width: 'auto', whiteSpace: 'nowrap' }} onClick={() => setImage({ seed: -1 })}>랜덤</button>
                  </div>
                </div>

                <div>
                  <label>네거티브 프롬프트</label>
                  <textarea className="form-control mono" value={settings.image.negativePrompt} onChange={(e) => setImage({ negativePrompt: e.target.value })} style={{ minHeight: '72px' }} />
                  {settings.image.negativePrompt !== info.defaultNegative && (
                    <button className="btn ghost" onClick={() => setImage({ negativePrompt: info.defaultNegative })}>모델 기본값으로</button>
                  )}
                </div>

                <label className="check">
                  <input type="checkbox" checked={settings.image.qualityTags} onChange={(e) => setImage({ qualityTags: e.target.checked })} />
                  품질 태그 자동 추가
                </label>
                {info.transparency && (
                  <label className="check">
                    <input type="checkbox" checked={settings.image.transparent} onChange={(e) => setImage({ transparent: e.target.checked })} />
                    투명 배경 (V5)
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={settings.image.thoroughTags} onChange={(e) => setImage({ thoroughTags: e.target.checked })} />
                  태그 변환 때 GLM이 먼저 생각하기 (느리지만 더 꼼꼼해요)
                </label>
              </div>
            )}
          </div>
        </div>

        <h3 className="section-title">갤러리</h3>
        {images.length === 0 ? (
          <p className="empty">아직 만든 이미지가 없어요.</p>
        ) : (
          <div className="gallery-grid">
            {images.map((img) => <Thumb key={img.id} img={img} onClick={() => setActiveImage(img)} />)}
          </div>
        )}
      </div>
    </div>
  );
}
