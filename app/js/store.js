// 로컬 저장소(IndexedDB). 모든 쓰기는 여기 먼저 들어가고, 동기화는 그 뒤에 따라온다.
// 서버가 없거나 오프라인이어도 기록은 절대 사라지지 않게 하는 것이 목표.
import { CATS, todayS } from './util.js';

const DB_NAME = 'saenggak-seojae-app';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

export const db = {
  allNotes: () => tx('notes', 'readonly', s => s.getAll()),
  putNote: n => tx('notes', 'readwrite', s => { s.put(n); }),
  putNotes: ns => tx('notes', 'readwrite', s => { ns.forEach(n => s.put(n)); }),
  clearNotes: () => tx('notes', 'readwrite', s => { s.clear(); }),
  get: k => tx('kv', 'readonly', s => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', s => { s.put(v, k); }),
  del: k => tx('kv', 'readwrite', s => { s.delete(k); }),
};

export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* 무시 */ }
}

// 분류 체계는 글에서 파생한다: 분야는 고정 6개, 갈래 = 그 분야 글들이 쓰는 sub 목록.
// 갈래가 처음 생긴 날(born)만 별도 맵으로 기억한다. 글이 하나도 없는 갈래는 자연히 사라진다.
export function deriveCats(notes, subBorn) {
  return CATS.map(c => {
    const map = new Map();
    for (const n of notes) {
      if (n.cat !== c.key) continue;
      const prev = map.get(n.sub);
      if (!prev || n.date < prev) map.set(n.sub, n.date);
    }
    const subs = [...map.entries()].map(([name, first]) => ({ name, born: subBorn[c.key + '/' + name] || first }))
      .sort((a, b) => a.born.localeCompare(b.born) || a.name.localeCompare(b.name));
    return { ...c, subs };
  });
}

// 프로토타입 백업({cats, notes}) 또는 이 앱의 백업을 받아들인다
export function normalizeImport(j) {
  if (!j || !Array.isArray(j.notes)) throw new Error('bad');
  const now = new Date().toISOString();
  const subBorn = { ...(j.subBorn || {}) };
  if (Array.isArray(j.cats)) j.cats.forEach(c => (c.subs || []).forEach(s => {
    const k = c.key + '/' + s.name;
    if (s.born && (!subBorn[k] || s.born < subBorn[k])) subBorn[k] = s.born;
  }));
  const keys = new Set(CATS.map(c => c.key));
  const notes = j.notes.filter(n => n && n.id && n.body).map(n => ({
    id: String(n.id),
    date: n.date || todayS(),
    cat: keys.has(n.cat) ? n.cat : 'daily',
    sub: String(n.sub || '생각'),
    tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
    summary: String(n.summary || ''),
    body: String(n.body),
    ...(n.book ? { book: n.book } : {}),
    ...(Array.isArray(n.checks) && n.checks.length ? { checks: n.checks } : {}),
    ...(n.edited ? { edited: n.edited } : {}),
    ...(n.aiPending ? { aiPending: true } : {}),
    ...(n.aiProvider ? { aiProvider: n.aiProvider } : {}),
    createdAt: n.createdAt || (n.date ? n.date + 'T12:00:00.000Z' : now),
    updatedAt: now,
    ...(n.deletedAt ? { deletedAt: n.deletedAt } : {}),
    dirty: true,
  }));
  return { notes, subBorn };
}

// 서버/백업으로 내보낼 때 로컬 전용 필드는 뺀다
export const clean = n => { const { dirty, ...rest } = n; return rest; };
