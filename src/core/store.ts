// Everything is stored on the device: settings in localStorage, documents and images in IndexedDB.
import { DEFAULT_IMAGE_SETTINGS, DEFAULT_SETTINGS } from './models';
import type { Chat, GalleryImage, Settings, Story } from './types';
import { base64ToBytes, uid } from './util';

const SETTINGS_KEY = 'nai-studio.settings';
const API_KEY_KEY = 'nai-studio.apiKey';
const DB_NAME = 'nai-studio';
const DB_VERSION = 1;
type StoreName = 'stories' | 'chats' | 'images';

// ------------------------------------------------------------ settings

export function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    // corrupted or unavailable storage
  }
  let apiKey = '';
  try {
    apiKey = localStorage.getItem(API_KEY_KEY) ?? sessionStorage.getItem(API_KEY_KEY) ?? '';
  } catch {
    // ignore
  }
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    image: { ...DEFAULT_IMAGE_SETTINGS, ...(saved.image ?? {}) },
    genByModel: { ...(saved.genByModel ?? {}) },
    apiKey,
  };
}

/** The API key goes to localStorage only when rememberKey is on; otherwise it lives for this tab session. */
export function saveSettings(s: Settings): void {
  const { apiKey, ...rest } = s;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
    if (s.rememberKey) {
      localStorage.setItem(API_KEY_KEY, apiKey);
      sessionStorage.removeItem(API_KEY_KEY);
    } else {
      sessionStorage.setItem(API_KEY_KEY, apiKey);
      localStorage.removeItem(API_KEY_KEY);
    }
  } catch {
    // storage full or blocked; settings stay in memory for this session
  }
}

// ------------------------------------------------------------ factories

export function newStory(init: Partial<Story> = {}): Story {
  const now = Date.now();
  return {
    id: uid(),
    title: '새 이야기',
    createdAt: now,
    updatedAt: now,
    systemPrompt: '',
    authorsNote: '',
    glossary: [],
    segments: [],
    ...init,
  };
}

/** A non-empty greeting becomes the first assistant message (translated to English when needed). */
export function newChat(init: Partial<Chat> & { greeting?: string } = {}): Chat {
  const { greeting, ...rest } = init;
  const now = Date.now();
  return {
    id: uid(),
    title: '새 대화',
    createdAt: now,
    updatedAt: now,
    systemPrompt: '',
    charName: '',
    userName: '',
    glossary: [],
    messages: greeting?.trim() ? [{ id: uid(), role: 'assistant', en: '', ko: greeting.trim(), createdAt: now }] : [],
    ...rest,
  };
}

// ------------------------------------------------------------ IndexedDB

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['stories', 'chats', 'images'] as StoreName[]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function all<T extends { updatedAt?: number; createdAt: number }>(store: StoreName): Promise<T[]> {
  const rows = await tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  return rows.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
}

export const db = {
  listStories: () => all<Story>('stories'),
  getStory: (id: string) => tx<Story | undefined>('stories', 'readonly', (s) => s.get(id)),
  saveStory: (story: Story) => tx('stories', 'readwrite', (s) => s.put(story)).then(() => story),
  deleteStory: (id: string) => tx('stories', 'readwrite', (s) => s.delete(id)).then(() => undefined),

  listChats: () => all<Chat>('chats'),
  getChat: (id: string) => tx<Chat | undefined>('chats', 'readonly', (s) => s.get(id)),
  saveChat: (chat: Chat) => tx('chats', 'readwrite', (s) => s.put(chat)).then(() => chat),
  deleteChat: (id: string) => tx('chats', 'readwrite', (s) => s.delete(id)).then(() => undefined),

  listImages: () => all<GalleryImage>('images'),
  saveImage: (img: GalleryImage) => tx('images', 'readwrite', (s) => s.put(img)).then(() => img),
  deleteImage: (id: string) => tx('images', 'readwrite', (s) => s.delete(id)).then(() => undefined),

  /** One JSON file with every story, chat and image (images as base64). The API key is never included. */
  async exportAll(): Promise<Blob> {
    const [stories, chats, images] = await Promise.all([this.listStories(), this.listChats(), this.listImages()]);
    const imgs = await Promise.all(
      images.map(async ({ blob, ...rest }) => ({ ...rest, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) })),
    );
    const payload = { app: 'nai-studio', version: 1, exportedAt: Date.now(), stories, chats, images: imgs };
    return new Blob([JSON.stringify(payload)], { type: 'application/json' });
  },

  /** Merges a backup into the database. Entries with the same id are overwritten. */
  async importAll(file: Blob): Promise<{ stories: number; chats: number; images: number }> {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'nai-studio') throw new Error('NAI 스튜디오 백업 파일이 아니에요.');
    for (const s of data.stories ?? []) await this.saveStory(s);
    for (const c of data.chats ?? []) await this.saveChat(c);
    for (const { data: b64, ...rest } of data.images ?? []) {
      await this.saveImage({ ...rest, blob: new Blob([base64ToBytes(b64)], { type: rest.mime }) });
    }
    return { stories: data.stories?.length ?? 0, chats: data.chats?.length ?? 0, images: data.images?.length ?? 0 };
  },
};

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
