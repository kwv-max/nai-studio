import { useEffect, useRef, useState } from 'react';
import { useAppContext } from './App';
import { db, IMAGE_MODELS, IMAGE_SIZES, IMAGE_SAMPLERS, imageModelInfo, isFreeForOpus, isAbortError, type GalleryImage, type ImageSettings } from '../core';
import { ChevronLeft, ChevronDown, ChevronUp, Download, Share2, Trash2, RefreshCcw } from 'lucide-react';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
const fileName = (img: GalleryImage) => `nai-${img.seed}.${EXT[img.mime] ?? 'png'}`;

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
  const { settings, updateSettings, studio, showToast, isBusy, setBusy, imageDraftText, setImageDraftText, dataVersion } = useAppContext();
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [task, setTask] = useState<'tags' | 'image' | null>(null);
  const [showOptions, setShowOptions] = useState(false);

  const [images, setImages] = useState<GalleryImage[]>([]);
  const [activeImage, setActiveImage] = useState<GalleryImage | null>(null);
  const activeUrl = useBlobUrl(activeImage?.blob);

  const abortCtrlRef = useRef<AbortController | null>(null);

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

  const convertToTags = async (text: string, fromStory: boolean) => {
    if (!text.trim()) return;
    const ctrl = begin('tags');
    if (!ctrl) return;
    setTags('');
    try {
      setTags(await studio.textToTags(text, { fromStory, signal: ctrl.signal, onText: setTags }));
    } catch (e: any) {
      if (!isAbortError(e)) showToast(e.message);
    } finally {
      end();
    }
  };

  // "이 장면 그리기" from the novel or chat tab.
  useEffect(() => {
    if (!imageDraftText) return;
    const text = imageDraftText;
    setImageDraftText('');
    setActiveImage(null);
    setDescription('');
    convertToTags(text, true);
  }, [imageDraftText]);

  const handleGenerate = async () => {
    if (!tags.trim()) return;
    const ctrl = begin('image');
    if (!ctrl) return;
    try {
      const img = await studio.generateImage({ prompt: tags, sourceKo: description.trim() || undefined }, ctrl.signal);
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
          <button
            className="btn secondary"
            onClick={() => {
              setTags(activeImage.prompt);
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

  const free = isFreeForOpus(settings);

  return (
    <div className="screen">
      <div className="header">
        <div style={{ width: '44px' }} />
        <h1>이미지</h1>
        <span className={`cost-badge ${free ? 'free' : 'paid'}`}>{free ? 'Opus 무료' : 'Anlas 소모'}</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div className="page-form">
          <div className="form-group">
            <label>묘사 (한국어)</label>
            <textarea
              className="form-control"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="예: 비 오는 밤, 등대 창가에 선 은발 소녀"
              style={{ minHeight: '72px' }}
            />
            <button
              className="btn secondary"
              style={{ marginTop: '8px' }}
              onClick={() => (task === 'tags' ? abortCtrlRef.current?.abort() : convertToTags(description, false))}
              disabled={task === 'image' || (task !== 'tags' && (isBusy || !description.trim()))}
            >
              {task === 'tags' ? '변환 중… (눌러서 중지)' : '태그로 변환 ↓'}
            </button>
          </div>

          <div className="form-group">
            <label>태그 (영어) — 직접 입력해도 돼요</label>
            <textarea
              className="form-control"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="1girl, silver hair, lighthouse, rain, night"
              style={{ minHeight: '88px' }}
            />
          </div>

          {task === 'image' ? (
            <button className="btn danger" onClick={() => abortCtrlRef.current?.abort()}>생성 중… (눌러서 중지)</button>
          ) : (
            <button className="btn" onClick={handleGenerate} disabled={isBusy || !tags.trim()}>이미지 생성</button>
          )}

          <div className="options">
            <button className="options-toggle" onClick={() => setShowOptions(!showOptions)}>
              <span>옵션 <span className="muted">· {imageModelInfo(settings.image.model).label} · {settings.image.width}×{settings.image.height}</span></span>
              {showOptions ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            </button>

            {showOptions && (
              <div className="options-body">
                <div>
                  <label>모델</label>
                  <select
                    className="form-control"
                    value={settings.image.model}
                    onChange={(e) => {
                      const info = imageModelInfo(e.target.value);
                      const prevDefault = imageModelInfo(settings.image.model).defaultNegative;
                      // Swap the negative prompt too, unless the user customised it.
                      setImage({ model: e.target.value, ...(settings.image.negativePrompt === prevDefault ? { negativePrompt: info.defaultNegative } : {}) });
                    }}
                  >
                    {IMAGE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
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
                  <textarea className="form-control" value={settings.image.negativePrompt} onChange={(e) => setImage({ negativePrompt: e.target.value })} style={{ minHeight: '72px' }} />
                </div>

                <label className="check">
                  <input type="checkbox" checked={settings.image.qualityTags} onChange={(e) => setImage({ qualityTags: e.target.checked })} />
                  품질 태그 자동 추가
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
