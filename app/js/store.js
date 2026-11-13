// 로컬 저장소(IndexedDB). 모든 쓰기는 여기 먼저 들어가고, 동기화는 그 뒤에 따라온다.
// 서버가 없거나 오프라인이어도 기록은 절대 사라지지 않게 하는 것이 목표.
import { getCats, todayS } from './util.js';

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

// 분류 체계는 글에서 파생한다: 분야 = 사용자의 분야 목록, 갈래 = 그 분야 글들이 쓰는 sub 목록.
// 갈래가 처음 생긴 날(born)만 별도 맵으로 기억한다. 글이 하나도 없는 갈래는 자연히 사라진다.
export function deriveCats(notes, subBorn) {
  // 목록에 없는 분야를 가리키는 글(다른 기기에서 아직 분야 목록이 안 넘어온 경우 등)은
  // '분류 안 됨' 칸에 모아 보여 준다. 이 칸은 분야 관리·분류 편집기에는 나오지 않는다.
  const known = new Set(getCats().map(c => c.key));
  const orphanKeys = [...new Set(notes.filter(n => !known.has(n.cat)).map(n => n.cat))];
  const list = [...getCats(), ...orphanKeys.map(key => ({ key, name: '분류 안 됨', emoji: '📁', hue: 60, virtual: true }))];
  return list.map(c => {
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
  // 백업에 있던 분야 중 지금 목록에 없는 것은 함께 들여온다(글이 가리키는 분야를 잃지 않도록)
  const fileCats = Array.isArray(j.cats) ? j.cats.filter(c => c && c.key && c.name).map(({ key, name, emoji, hue }) => ({ key, name, emoji, hue })) : [];
  const keys = new Set([...getCats(), ...fileCats].map(c => c.key));
  const fallback = keys.has('daily') ? 'daily' : getCats()[0].key;
  const notes = j.notes.filter(n => n && n.id && n.body).map(n => ({
    id: String(n.id),
    date: n.date || todayS(),
    cat: keys.has(n.cat) ? n.cat : fallback,
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
  return { notes, subBorn, fileCats };
}

// 서버/백업으로 내보낼 때 로컬 전용 필드는 뺀다
export const clean = n => { const { dirty, ...rest } = n; return rest; };
