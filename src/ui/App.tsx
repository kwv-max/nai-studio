import { createContext, useContext, useMemo, useRef, useState } from 'react';
import { createStudio, loadSettings, saveSettings, type Settings, type Studio } from '../core';
import './App.css';
import { SettingsView } from './SettingsView';
import { NovelView } from './NovelView';
import { ChatView } from './ChatView';
import { ImageView } from './ImageView';
import { BookOpen, MessageSquare, Image as ImageIcon, Settings as SettingsIcon } from 'lucide-react';

interface AppContextType {
  settings: Settings;
  updateSettings: (s: Partial<Settings>) => void;
  studio: Studio;
  isBusy: boolean;
  setBusy: (b: boolean) => void;
  showToast: (msg: string) => void;
  navigate: (tab: Tab) => void;
  /** Set by "이 장면 그리기" in the novel/chat tabs; the image tab picks it up. */
  imageDraft: ImageDraft | null;
  setImageDraft: (d: ImageDraft | null) => void;
  /** Bumped when stored data changes outside a view (e.g. backup import), so lists reload. */
  dataVersion: number;
  bumpData: () => void;
}

export interface ImageDraft {
  /** Passage or message to draw (English original when there is one: converts more accurately). */
  text: string;
  /** What the description box shows (Korean when there is one). */
  display: string;
  /** Story/chat settings and glossary, for consistent character looks. */
  reference: string;
  /** Where it came from, shown to the user (e.g. the story title). */
  source: string;
}

export type Tab = 'novel' | 'chat' | 'image' | 'settings';

export const AppContext = createContext<AppContextType | null>(null);

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('Missing AppContext');
  return ctx;
}

const TABS: { id: Tab; label: string; Icon: typeof BookOpen }[] = [
  { id: 'novel', label: '소설', Icon: BookOpen },
  { id: 'chat', label: '채팅', Icon: MessageSquare },
  { id: 'image', label: '이미지', Icon: ImageIcon },
  { id: 'settings', label: '설정', Icon: SettingsIcon },
];

export function App() {
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [isBusy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>(() => (settings.apiKey || settings.mock ? 'novel' : 'settings'));
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const [imageDraft, setImageDraft] = useState<ImageDraft | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const toastSeq = useRef(0);

  const updateSettings = (s: Partial<Settings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...s };
      saveSettings(next);
      return next;
    });
  };

  const studio = useMemo(() => createStudio(settings), [settings]);

  const showToast = (msg: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  };

  const ctx: AppContextType = {
    settings,
    updateSettings,
    studio,
    isBusy,
    setBusy,
    showToast,
    navigate: setActiveTab,
    imageDraft,
    setImageDraft,
    dataVersion,
    bumpData: () => setDataVersion((v) => v + 1),
  };

  // Every tab stays mounted so an open story/chat and any running generation survive tab switches.
  const pane = (tab: Tab) => ({ style: { display: activeTab === tab ? 'contents' : 'none' } });

  return (
    <AppContext.Provider value={ctx}>
      <div className="app-container">
        <div {...pane('novel')}><NovelView /></div>
        <div {...pane('chat')}><ChatView /></div>
        <div {...pane('image')}><ImageView /></div>
        <div {...pane('settings')}><SettingsView /></div>

        {settings.mock && <div className="demo-ribbon">데모 모드 · 가짜 응답이에요 (설정에서 끌 수 있어요)</div>}
        <nav className="tab-bar">
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} className={`tab-item ${activeTab === id ? 'active' : ''}`} onClick={() => setActiveTab(id)}>
              <Icon size={24} className="tab-icon" />
              <span className="tab-label">{label}</span>
            </button>
          ))}
        </nav>

        <div className="toast-container" role="status">
          {toasts.map((t) => (
            <div key={t.id} className="toast">{t.msg}</div>
          ))}
        </div>
      </div>
    </AppContext.Provider>
  );
}
