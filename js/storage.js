/**
 * CheatingGuard 기기 내부 저장소 (IndexedDB + localStorage)
 * 외부 서버로 어떤 데이터도 전송하지 않는다.
 */
const DB_NAME = 'cheatingguard';
const DB_VERSION = 1;
const SETTINGS_KEY = 'cheatingguard.settings.v1';

export const DEFAULT_SETTINGS = {
  onboarded: false,
  alertMode: 'vibrate',     // sound | vibrate | silent
  alertsEnabled: false,     // 사용자가 승인해야 활성화
  sensitivity: 'normal',
  recordEnabled: false,     // 기록 저장 기본 비활성
  showAllBle: false,
};

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class StorageError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function wrapErr(e) {
  if (e && (e.name === 'QuotaExceededError' || e.code === 22)) return new StorageError('quota', '저장 공간이 부족합니다. 기록을 내보낸 뒤 삭제해 주세요.');
  return new StorageError('io', '저장소 작업 중 오류가 발생했습니다.');
}

class Storage {
  constructor() {
    this.db = null;
    this.persistent = false;
    this.memory = { userDevices: new Map(), logs: new Map(), meta: new Map() };
    this.memSeq = 1;
    this._opening = null;
  }

  open() {
    if (this._opening) return this._opening;
    this._opening = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(false);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('userDevices')) db.createObjectStore('userDevices', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => { this.db = req.result; this.persistent = true; resolve(true); };
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
        setTimeout(() => resolve(!!this.db), 4000);
      } catch (_) { resolve(false); }
    });
    return this._opening;
  }

  async _tx(store, mode, fn) {
    await this.open();
    if (!this.db) return fn(null);
    try {
      const tx = this.db.transaction(store, mode);
      const done = new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
      const os = tx.objectStore(store);
      const result = await fn(os);
      await done;
      return result;
    } catch (e) { throw wrapErr(e); }
  }

  async getAll(store) {
    return this._tx(store, 'readonly', (os) => os ? reqP(os.getAll()) : [...this.memory[store].values()]);
  }
  async put(store, value) {
    return this._tx(store, 'readwrite', (os) => {
      if (os) return reqP(os.put(value));
      const key = value.id != null ? value.id : value.key != null ? value.key : (value.id = this.memSeq++);
      this.memory[store].set(key, value); return key;
    });
  }
  async add(store, value) {
    return this._tx(store, 'readwrite', (os) => {
      if (os) return reqP(os.add(value));
      value.id = this.memSeq++; this.memory[store].set(value.id, value); return value.id;
    });
  }
  async delete(store, key) {
    return this._tx(store, 'readwrite', (os) => os ? reqP(os.delete(key)) : this.memory[store].delete(key));
  }
  async clear(store) {
    return this._tx(store, 'readwrite', (os) => os ? reqP(os.clear()) : this.memory[store].clear());
  }

  loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return Object.assign({}, DEFAULT_SETTINGS, raw ? JSON.parse(raw) : {});
    } catch (_) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); return true; } catch (_) { return false; }
  }

  async estimate() {
    try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (_) { return null; }
  }

  /** 앱 데이터 전체 초기화 (캐시는 별도) */
  async resetAll() {
    for (const s of ['userDevices', 'logs', 'meta']) { try { await this.clear(s); } catch (_) {} }
    try { localStorage.removeItem(SETTINGS_KEY); } catch (_) {}
  }
}

export const storage = new Storage();
