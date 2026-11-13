import { morph, esc } from './morph.js';
import { getCats, setCats, nextHue, MAX_CATS, DEFAULT_CATS, catOf, catColor, todayS, pd, daysAgo, fmt, fmtPlain, shortDate, rel, todayLabel, uid, bookMeta, DOW } from './util.js';
import { db, deriveCats, normalizeImport, clean, requestPersist } from './store.js';
import { sync } from './sync.js';
import { ai, nlScore, isShort, oneLine } from './ai.js';
import { layoutNet } from './net.js';

// ───────────────────────── 상태 ─────────────────────────
const S = {
  ready: false,
  w: window.innerWidth,
  screen: 'write', tab: 'write', from: null, depth: 0,
  notes: [], subBorn: {},
  draft: '', phase: 'idle', resId: null, resNew: false, resNote: '', editing: false, newTag: '',
  libView: 'shelf', shelfKey: null, catKey: null, subFilter: null, noteId: null,
  query: '', answer: null, aiLoading: false, newSub: '', detailEditing: false,
  checks: null, checkStatus: 'idle', bodyEditing: false, bodyDraft: '', netSel: null,
  listening: false, voiceErr: null, book: null, bookStatus: 'idle', bookDismissed: false,
  email: '', code: '', loginStage: 'idle', loginErr: null, loginBusy: false,
  lastExport: null, aiUsage: {}, toast: null, landingDone: false,
  // 분야 관리
  catsAt: null, catsDirty: false, catMgr: false, newCatName: '', newCatEmoji: '', catErr: null, delCat: null, delTarget: null,
};
const root = document.getElementById('app');
let timer = null, bookTimer = null, bookToken = null, checkToken = null, lastKey = null, lastLen = 0, rec = null, toastTimer = null, syncTimer = null;
let ta = null;

const live = () => S.notes.filter(n => !n.deletedAt);
const sorted = () => live().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id));
const cats = () => deriveCats(live(), S.subBorn);
const findNote = id => S.notes.find(n => n.id === id && !n.deletedAt);
const monthKey = () => todayS().slice(0, 7);

let queued = false;
function set(p) { Object.assign(S, p); if (!queued) { queued = true; queueMicrotask(() => { queued = false; render(); }); } }
function toast(msg) { clearTimeout(toastTimer); set({ toast: msg }); toastTimer = setTimeout(() => set({ toast: null }), 2600); }

// ───────────────────────── 저장 ─────────────────────────
async function writeNote(n) {
  n.updatedAt = new Date().toISOString();
  n.dirty = true;
  const i = S.notes.findIndex(x => x.id === n.id);
  const notes = [...S.notes];
  if (i >= 0) notes[i] = n; else notes.unshift(n);
  set({ notes });
  try { await db.putNote(n); } catch (e) { toast('이 기기에 저장하지 못했어요. 저장 공간을 확인해 주세요.'); }
  scheduleSync();
}
function patch(id, p) { const n = S.notes.find(x => x.id === id); if (n) writeNote({ ...n, ...p }); }
function addBorn(cat, sub, date = todayS()) {
  const k = cat + '/' + sub;
  if (S.subBorn[k]) return;
  const subBorn = { ...S.subBorn, [k]: date };
  set({ subBorn }); db.set('subBorn', subBorn);
}

// ───────────────────────── 분야 관리 ─────────────────────────
async function saveCats(list, { dirty = true, at = new Date().toISOString() } = {}) {
  setCats(list);
  const rec = { list: getCats(), updatedAt: at, dirty };
  set({ catsAt: at, catsDirty: dirty });
  try { await db.set('cats', rec); } catch (e) { /* 무시 */ }
  if (dirty) scheduleSync();
}
function addCat() {
  const name = S.newCatName.replace(/[<>&"'`]/g, '').trim();
  const emoji = S.newCatEmoji.replace(/[<>&"'`\s]/g, '').trim() || '📁';
  if (!name) { set({ catErr: '분야 이름을 적어 주세요.' }); return; }
  if (getCats().length >= MAX_CATS) { set({ catErr: `분야는 ${MAX_CATS}개까지 만들 수 있어요.` }); return; }
  if (getCats().some(c => c.name === name)) { set({ catErr: '같은 이름의 분야가 이미 있어요.' }); return; }
  saveCats([...getCats(), { key: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, emoji, hue: nextHue() }]);
  set({ newCatName: '', newCatEmoji: '', catErr: null });
  toast(`‘${name}’ 분야를 만들었어요.`);
}
function askDeleteCat(key) {
  if (getCats().length <= 1) { set({ catErr: '분야는 하나 이상 있어야 해요.' }); return; }
  const others = getCats().filter(c => c.key !== key);
  set({ delCat: key, delTarget: (others.find(c => c.key === 'daily') || others[0]).key, catErr: null });
}
async function deleteCat() {
  const key = S.delCat; if (!key) return;
  const c = getCats().find(x => x.key === key); if (!c) { set({ delCat: null }); return; }
  const moving = live().filter(n => n.cat === key);
  const target = moving.length ? getCats().find(x => x.key === S.delTarget && x.key !== key) : null;
  if (moving.length && !target) return;
  if (!confirm(moving.length ? `‘${c.name}’ 분야를 지우고 글 ${moving.length}편을 ‘${target.name}’ 분야로 옮길까요?` : `‘${c.name}’ 분야를 지울까요?`)) return;
  // 글을 먼저 옮기고(갈래 이름은 그대로) 분야를 지운다
  for (const n of moving) { addBorn(target.key, n.sub); await writeNote({ ...n, cat: target.key, userSorted: true }); }
  await saveCats(getCats().filter(x => x.key !== key));
  set({ delCat: null, delTarget: null, shelfKey: S.shelfKey === key ? null : S.shelfKey });
  toast(moving.length ? `글 ${moving.length}편을 ‘${target.name}’(으)로 옮기고 분야를 지웠어요.` : `‘${c.name}’ 분야를 지웠어요.`);
}
function resetCats() {
  if (!confirm('분야 목록을 처음 6개로 되돌릴까요? 직접 만든 분야는 목록에서 빠지고, 그 분야의 글은 ‘분류 안 됨’으로 남아요.')) return;
  saveCats(DEFAULT_CATS);
}

function scheduleSync(delay = 1200) {
  if (!sync.configured() || !sync.session()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}
const syncApi = {
  getNotes: () => S.notes,
  async applyRemote(remote) {
    const map = new Map(S.notes.map(n => [n.id, n]));
    const changed = [];
    for (const r of remote) {
      const l = map.get(r.id);
      if (!l || (r.updatedAt > l.updatedAt)) { const n = { ...r, dirty: false }; map.set(r.id, n); changed.push(n); }
    }
    if (changed.length) { await db.putNotes(changed); set({ notes: [...map.values()] }); }
  },
  async markClean(pairs) {
    const changed = [];
    const notes = S.notes.map(n => {
      const p = pairs.find(([id]) => id === n.id);
      if (p && p[1] === n.updatedAt && n.dirty) { const c = { ...n, dirty: false }; changed.push(c); return c; }
      return n;
    });
    if (changed.length) { await db.putNotes(changed); S.notes = notes; }
  },
  // 분야 목록: 바뀐 쪽이 이긴다(가장 최근에 고친 기기의 목록)
  getCatsDirty: () => (S.catsDirty ? { list: getCats(), updatedAt: S.catsAt } : null),
  async markCatsClean(at) { if (S.catsAt === at && S.catsDirty) await saveCats(getCats(), { dirty: false, at }); },
  async mergeCats(remote) {
    if (!remote || !Array.isArray(remote.list) || !remote.list.length || !remote.updatedAt) return;
    if (!S.catsAt || remote.updatedAt > S.catsAt) await saveCats(remote.list, { dirty: false, at: remote.updatedAt });
  },
  getSubBorn: () => S.subBorn,
  async mergeSubBorn(remote) {
    const sb = { ...S.subBorn };
    let ch = false;
    for (const [k, v] of Object.entries(remote || {})) if (!sb[k] || v < sb[k]) { sb[k] = v; ch = true; }
    if (ch) { await db.set('subBorn', sb); set({ subBorn: sb }); }
  },
};
async function runSync() {
  await sync.run(syncApi);
  reclassifyPending();
}

// AI가 실패해 휴리스틱으로 분류된 글을 나중에 다시 정리한다
let reclassifying = false;
async function reclassifyPending() {
  if (reclassifying || !ai.available()) return;
  const pending = live().filter(n => n.aiPending && !n.userSorted).slice(0, 5);
  if (!pending.length) return;
  reclassifying = true;
  try {
    for (const n of pending) {
      const r = await ai.classify(n.body, cats(), n.book);
      if (r.aiPending) break; // 아직 AI가 안 됨
      const cur = findNote(n.id);
      if (!cur || cur.userSorted) continue;
      addBorn(r.cat, r.sub);
      const { aiPending, ...rest } = cur;
      writeNote({ ...rest, cat: r.cat, sub: r.sub, tags: r.tags, summary: r.summary, aiProvider: r.aiProvider });
    }
  } finally { reclassifying = false; }
}

// ───────────────────────── 화면 이동 ─────────────────────────
const SCREEN_LABEL = { write: '기록', library: '서재', timeline: '흐름', search: '검색', category: '분야', detail: '이전 글' };
function snapshot() { return { screen: S.screen, tab: S.tab, noteId: S.noteId, catKey: S.catKey, subFilter: S.subFilter, from: S.from, depth: S.depth }; }
function go(screen) {
  set({ screen, tab: screen, depth: 0, from: null, noteId: null, bodyEditing: false, detailEditing: false, netSel: screen === 'timeline' ? S.netSel : null });
  history.replaceState(snapshot(), '');
  window.scrollTo(0, 0);
  if (screen === 'write') focusDraft();
}
function push(p) {
  history.replaceState({ ...snapshot(), scrollY: window.scrollY }, '');
  const fromLabel = S.screen === 'category' ? catOf(S.catKey).name : SCREEN_LABEL[S.screen];
  set({ ...p, from: fromLabel, depth: S.depth + 1, bodyEditing: false, detailEditing: false, newSub: '' });
  history.pushState(snapshot(), '');
  window.scrollTo(0, 0);
}
const openNote = id => push({ screen: 'detail', noteId: id });
const openCat = (key, sub = null) => push({ screen: 'category', tab: 'library', catKey: key, subFilter: sub });
function back() {
  if (S.depth > 0) history.back();
  else go('library');
}
window.addEventListener('popstate', e => {
  const st = e.state;
  if (!st) { go('write'); return; }
  set({ ...st, bodyEditing: false, detailEditing: false });
  requestAnimationFrame(() => window.scrollTo(0, st.scrollY || 0));
});
function focusDraft() { setTimeout(() => { if (ta && S.screen === 'write' && S.phase === 'idle') ta.focus(); }, 60); }

// ───────────────────────── 빠른 기록 ─────────────────────────
function onDraft(v) {
  set({ draft: v });
  try { localStorage.setItem('seojae-draft', v); } catch (e) { /* 무시 */ }
  if (!v.trim()) {
    clearTimeout(bookTimer); bookToken = null; lastKey = null; checkToken = null;
    set({ book: null, bookStatus: 'idle', bookDismissed: false, checks: null, checkStatus: 'idle' });
    return;
  }
  clearTimeout(bookTimer);
  bookTimer = setTimeout(lookupBook, 1200);
}

async function lookupBook() {
  const text = S.draft;
  if (S.bookDismissed || S.bookStatus === 'loading') return;
  const br = text.match(/[『《「<]([^』》」>\n]{1,60})[』》」>]/);
  const cand = br ? br[1].trim() : null;
  if (!cand && !/책|읽|저자|작가|소설|에세이|완독|밑줄/.test(text)) return;
  const key = cand || 'kw';
  if (S.book && (cand ? S.book.key === key : true)) return;
  if (!cand && lastKey === 'kw' && Math.abs(text.length - lastLen) < 25) return;
  lastKey = key; lastLen = text.length;
  if (!ai.available()) { if (cand) set({ book: { key, title: cand }, bookStatus: 'found' }); return; }
  const token = bookToken = Symbol();
  set({ bookStatus: 'loading' });
  const b = await ai.findBook(text, cand);
  if (bookToken !== token) return;
  if (b && b.title) set({ book: { ...b, key, ai: true }, bookStatus: 'found' });
  else set({ bookStatus: cand ? 'found' : 'idle', book: cand ? { key, title: cand } : null });
}

async function save() {
  if (S.listening && rec) rec.stop();
  const text = S.draft.trim();
  if (!text || S.phase === 'classifying') return;
  clearTimeout(timer);
  const book = S.bookStatus === 'found' && !S.bookDismissed && S.book ? (({ key, ai: _a, ...b }) => b)(S.book) : null;
  clearTimeout(bookTimer); bookToken = null; lastKey = null;
  const checks = S.checkStatus === 'done' && S.checks && S.checks.length ? S.checks : null;
  checkToken = null;
  try { localStorage.removeItem('seojae-draft'); } catch (e) { /* 무시 */ }

  // 1) 일단 휴리스틱 결과로 바로 저장(유실 방지) → 2) AI 결과로 덮어쓴다
  const id = uid();
  const now = new Date().toISOString();
  const draftNote = { id, date: todayS(), cat: 'daily', sub: '생각', tags: [], summary: text.slice(0, 30), body: text, aiPending: true, createdAt: now, ...(book ? { book } : {}), ...(checks ? { checks } : {}) };
  set({ phase: 'classifying', draft: '', editing: false, book: null, bookStatus: 'idle', bookDismissed: false, checks: null, checkStatus: 'idle', resId: id, resNote: '' });
  await writeNote(draftNote);

  const before = cats();
  const r = await ai.classify(text, before, book);
  const c = before.find(x => x.key === r.cat) || before.find(x => x.key === 'daily') || before[0];
  const isNew = !c.subs.find(s => s.name === r.sub);
  addBorn(c.key, r.sub);
  const cur = S.notes.find(n => n.id === id) || draftNote;
  const { aiPending: _p, ...base } = cur;
  await writeNote({ ...base, cat: c.key, sub: r.sub, tags: r.tags, summary: r.summary, ...(r.aiPending ? { aiPending: true } : {}), ...(r.aiProvider ? { aiProvider: r.aiProvider } : {}) });
  const note = r.aiPending && sync.configured() && sync.session() ? 'AI 연결이 잠시 어려워 간단히 분류했어요. 곧 다시 정리할게요.' : '';
  set({ phase: 'done', resNew: isNew, resNote: note });
  arm();
}
function arm() { clearTimeout(timer); timer = setTimeout(() => { if (!S.editing) dismiss(); }, 4000); }
function dismiss() { clearTimeout(timer); set({ phase: 'idle', editing: false, newTag: '', newSub: '' }); if (S.screen === 'write') focusDraft(); }

function toggleVoice() {
  if (S.listening) { rec && rec.stop(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { set({ voiceErr: '이 브라우저는 음성 입력을 지원하지 않아요. 키보드의 마이크 버튼을 써 주세요.' }); return; }
  rec = new SR(); rec.lang = 'ko-KR'; rec.continuous = true; rec.interimResults = true;
  const base = S.draft; let finalText = '';
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += t; else interim += t; }
    const sep = base && !/\s$/.test(base) ? ' ' : '';
    onDraft(base + sep + finalText + interim);
  };
  rec.onerror = e => set({ listening: false, voiceErr: e.error === 'not-allowed' || e.error === 'service-not-allowed' ? '마이크 권한이 필요해요. 브라우저 설정에서 허용해 주세요.' : e.error === 'no-speech' || e.error === 'aborted' ? null : '음성을 인식하지 못했어요. 다시 시도해 주세요.' });
  rec.onend = () => set({ listening: false });
  try { rec.start(); set({ listening: true, voiceErr: null }); } catch (e) { set({ voiceErr: '음성 입력을 시작하지 못했어요.' }); }
}

async function runCheck() {
  const text = S.draft.trim(); if (!text || S.checkStatus === 'loading') return;
  if (!ai.available()) { set({ checkStatus: 'unavailable', checks: [] }); return; }
  const token = checkToken = Symbol();
  set({ checkStatus: 'loading', checks: null });
  const checks = await ai.factCheck(text);
  if (checkToken !== token) return;
  if (checks) set({ checkStatus: 'done', checks }); else set({ checkStatus: 'error', checks: [] });
}

// ───────────────────────── 분류 편집 ─────────────────────────
function setCatSub(id, cat, sub) {
  sub = String(sub).trim().replace(/^[›>#]\s*/, ''); if (!sub) return;
  const n = findNote(id); if (!n) return;
  addBorn(cat, sub);
  const { aiPending, ...rest } = n;
  writeNote({ ...rest, cat, sub, userSorted: true });
  set({ resNew: false });
}
function addSub(id) { const v = S.newSub.trim(); if (!v) return; const n = findNote(id); if (!n) return; setCatSub(id, n.cat, v); set({ newSub: '' }); }

// ───────────────────────── 글 수정·삭제 ─────────────────────────
function saveBody(id) {
  const body = S.bodyDraft.trim(); if (!body) return;
  const n = findNote(id); if (!n) return;
  // 짧은 글은 요약 대신 글 자체가 제목 역할을 하므로 함께 바꾼다
  writeNote({ ...n, body, ...(isShort(body) ? { summary: oneLine(body) } : {}), ...(body !== n.body ? { edited: todayS() } : {}) });
  set({ bodyEditing: false });
}
function deleteNote(id) {
  if (!confirm('이 글을 삭제할까요? 되돌릴 수 없어요.' + (sync.session() ? ' 동기화된 다른 기기에서도 지워져요.' : ''))) return;
  const n = findNote(id); if (!n) return;
  // 다른 기기에도 삭제를 알리기 위한 표시만 남기고, 본문·요약·태그 등 내용은 지운다
  writeNote({ id: n.id, date: n.date, cat: n.cat, sub: n.sub, tags: [], summary: '', body: '', createdAt: n.createdAt, deletedAt: new Date().toISOString() });
  set({ bodyEditing: false });
  back();
  toast('글을 삭제했어요.');
}

// ───────────────────────── 검색 ─────────────────────────
async function ask() {
  const q = S.query.trim(); if (!q) return;
  set({ aiLoading: true, answer: null });
  const all = sorted();
  if (ai.available()) {
    // 기록 전체 대신 후보 40개만 보낸다(토큰·무료 한도 절약)
    const scored = nlScore(q, all);
    const cand = [...scored, ...all.filter(n => !scored.includes(n))].slice(0, 40);
    const r = await ai.ask(q, cand);
    if (r) { set({ aiLoading: false, answer: { text: r.text, ids: r.ids.filter(id => findNote(id)).slice(0, 3) } }); return; }
  }
  await new Promise(r => setTimeout(r, 500));
  const hits = nlScore(q, all).slice(0, 3);
  const text = hits.length ? `${fmtPlain(hits[0].date)}에 “${hits[0].summary}”라고 남겼어요.${hits[1] ? ` 비슷한 생각은 ${fmtPlain(hits[1].date)}에도 있었어요.` : ''}` : '관련된 기록을 찾지 못했어요.';
  set({ aiLoading: false, answer: { text, ids: hits.map(n => n.id) } });
}

// ───────────────────────── 백업 ─────────────────────────
function exportData() {
  const payload = { app: '생각서재', version: 1, saved: new Date().toISOString(), cats: cats(), notes: sorted().map(clean), subBorn: S.subBorn };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `생각서재-백업-${todayS()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  const at = new Date().toISOString(); set({ lastExport: at }); db.set('lastExport', at);
}
function importData(file) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const { notes, subBorn, fileCats } = normalizeImport(JSON.parse(r.result));
      if (!confirm(`글 ${notes.length}편을 불러올까요? 지금 기록은 그대로 두고 합쳐요. (같은 글은 파일 내용으로 바뀌어요)`)) return;
      // 백업에만 있는 분야(직접 만든 분야 등)는 목록에 더한다
      const used = new Set(notes.map(n => n.cat));
      const extra = fileCats.filter(c => used.has(c.key) && !getCats().some(x => x.key === c.key));
      if (extra.length) await saveCats([...getCats(), ...extra]);
      const map = new Map(S.notes.map(n => [n.id, n]));
      notes.forEach(n => map.set(n.id, n));
      await db.putNotes(notes);
      const sb = { ...S.subBorn };
      for (const [k, v] of Object.entries(subBorn)) if (!sb[k] || v < sb[k]) sb[k] = v;
      await db.set('subBorn', sb);
      set({ notes: [...map.values()], subBorn: sb });
      toast(`${notes.length}편을 불러왔어요.`);
      scheduleSync(200);
    } catch (x) { alert('백업 파일을 읽지 못했어요.'); }
  };
  r.readAsText(file);
}
function resetAll() {
  if (!confirm('모든 기록을 지울까요? 되돌릴 수 없어요.' + (sync.session() ? ' 동기화된 다른 기기에서도 지워져요.' : ''))) return;
  const now = new Date().toISOString();
  const notes = S.notes.map(n => n.deletedAt ? n : { id: n.id, date: n.date, cat: n.cat, sub: n.sub, tags: [], summary: '', body: '', createdAt: n.createdAt, deletedAt: now, updatedAt: now, dirty: true });
  db.putNotes(notes); set({ notes, phase: 'idle' }); go('write'); scheduleSync(200);
}

// ───────────────────────── 로그인 ─────────────────────────
// 랜딩 페이지는 처음 한 번만: 로그인에 성공하거나 '나중에'를 고르면 다시 띄우지 않는다
function finishLanding() { if (!S.landingDone) { set({ landingDone: true }); db.set('landingDone', true); } }
const showLanding = () => S.ready && sync.configured() && !sync.session() && !S.landingDone;
async function sendLink() {
  const email = S.email.trim(); if (!/.+@.+\..+/.test(email)) { set({ loginErr: '이메일 주소를 확인해 주세요.' }); return; }
  set({ loginBusy: true, loginErr: null });
  try { await sync.sendLink(email); set({ loginStage: 'sent', loginBusy: false }); }
  catch (e) { set({ loginErr: e.message, loginBusy: false }); }
}
async function verifyCode() {
  set({ loginBusy: true, loginErr: null });
  try { await sync.verifyCode(S.email.trim(), S.code.trim()); set({ loginBusy: false }); } // 이후 처리는 sync.subscribe에서
  catch (e) { set({ loginErr: e.message, loginBusy: false }); }
}

// ───────────────────────── 이벤트 위임 ─────────────────────────
const A = {
  go: a => go(a), back, save, dismiss, toggleVoice, runCheck, exportData, resetAll, sendLink, verifyCode, ask,
  openNote: a => { if (S.phase !== 'idle') dismiss(); openNote(a); }, openCat: (a, el) => openCat(a, el.dataset.sub || null),
  importClick: () => document.getElementById('file-in').click(),
  dismissBook: () => { bookToken = null; set({ bookDismissed: true }); },
  closeVoiceErr: () => set({ voiceErr: null }),
  closeCheck: () => { checkToken = null; set({ checkStatus: 'idle', checks: null }); },
  removeCheck: a => set({ checks: S.checks.filter((_, k) => k !== +a) }),
  toggleCat: () => set({ editing: !S.editing, newSub: '' }),
  pickCat: (a, el) => { const id = el.dataset.id; const n = findNote(id); if (!n || n.cat === a) return; const c = cats().find(x => x.key === a); setCatSub(id, a, c.subs[0] ? c.subs[0].name : '일반'); },
  pickSub: (a, el) => { const n = findNote(el.dataset.id); if (n) setCatSub(n.id, n.cat, a); },
  addSub: a => addSub(a),
  removeTag: (a, el) => { const n = findNote(el.dataset.id); if (n) patch(n.id, { tags: n.tags.filter(t => t !== a), userSorted: true }); },
  libView: a => set({ libView: a }),
  shelf: a => set({ shelfKey: a }),
  subFilter: a => set({ subFilter: a || null }),
  startBodyEdit: () => { const n = findNote(S.noteId); if (n) set({ bodyEditing: true, bodyDraft: n.body }); },
  cancelBodyEdit: () => set({ bodyEditing: false }),
  saveBody: () => saveBody(S.noteId),
  deleteNote: () => deleteNote(S.noteId),
  toggleDetEdit: () => set({ detailEditing: !S.detailEditing, newSub: '' }),
  confirmCheck: a => { const n = findNote(S.noteId); if (n) patch(n.id, { checks: (n.checks || []).filter((_, k) => k !== +a) }); },
  netSel: a => set({ netSel: S.netSel === a ? null : a }),
  example: a => { set({ query: a, answer: null }); if (!a.startsWith('#')) ask(); },
  syncNow: () => runSync(),
  signOut: async () => { if (confirm('로그아웃할까요? 이 기기의 기록은 그대로 남아요.')) { await sync.signOut(); toast('로그아웃했어요.'); } },
  loginReset: () => set({ loginStage: 'idle', code: '', loginErr: null }),
  skipLanding: () => { finishLanding(); focusDraft(); },
  toggleCatMgr: () => set({ catMgr: !S.catMgr, delCat: null, catErr: null }),
  addCat, askDeleteCat: a => askDeleteCat(a), deleteCat, resetCats,
  cancelDeleteCat: () => set({ delCat: null, delTarget: null }),
  delTarget: a => set({ delTarget: a }),
};
const IN = {
  newCatName: v => set({ newCatName: v, catErr: null }), newCatEmoji: v => set({ newCatEmoji: v, catErr: null }),
  draft: onDraft, newTag: v => set({ newTag: v }), newSub: v => set({ newSub: v }), bodyDraft: v => set({ bodyDraft: v }),
  query: v => set({ query: v, answer: null }), email: v => set({ email: v, loginErr: null }), code: v => set({ code: v.replace(/\D/g, '').slice(0, 10), loginErr: null }),
};
const KD = {
  draft: e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } },
  newTag: e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const n = findNote(S.resId); const t = S.newTag.trim().replace(/^#/, '').replace(/\s/g, '');
    if (n && t && !n.tags.includes(t)) patch(n.id, { tags: [...n.tags, t], userSorted: true });
    set({ newTag: '' });
  },
  newSub: (e, el) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addSub(el.dataset.id); } },
  bodyDraft: e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBody(S.noteId); } },
  query: e => { if (e.key === 'Enter' && !e.isComposing && S.query.trim()) { e.preventDefault(); ask(); } },
  email: e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendLink(); } },
  code: e => { if (e.key === 'Enter') { e.preventDefault(); verifyCode(); } },
  newCatName: e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addCat(); } },
};
root.addEventListener('click', e => {
  if (e.target.closest('.sheet')) clearTimeout(timer); // 시트를 만지면 자동 닫힘 멈춤
  const el = e.target.closest('[data-act]');
  if (!el || !root.contains(el)) return;
  const f = A[el.dataset.act];
  if (f) { e.preventDefault(); f(el.dataset.arg ?? '', el, e); }
});
root.addEventListener('input', e => { const k = e.target.dataset && e.target.dataset.in; if (k && IN[k]) IN[k](e.target.value, e.target); });
root.addEventListener('keydown', e => { const k = e.target.dataset && e.target.dataset.kd; if (k && KD[k]) KD[k](e, e.target); });
root.addEventListener('change', e => { if (e.target.id === 'file-in' && e.target.files[0]) { importData(e.target.files[0]); e.target.value = ''; } });
window.addEventListener('resize', () => { if ((window.innerWidth >= 900) !== (S.w >= 900)) set({ w: window.innerWidth }); else S.w = window.innerWidth; });
window.addEventListener('online', () => { scheduleSync(300); render(); });
window.addEventListener('offline', () => render());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });

// ───────────────────────── 렌더 ─────────────────────────
const x = (cond, html) => cond ? html : '';
const each = (list, fn) => list.map(fn).join('');
const act = (name, arg = '', extra = '') => `data-act="${name}" data-arg="${esc(arg)}"${extra}`;
const micSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"></path></svg>';

function vLanding() {
  return `<div class="landing">
  <div class="landing-col">
    <div class="landing-logo">생각서재</div>
    <h1 class="landing-title">떠오르는 생각을<br>쓰기만 하세요.</h1>
    <p class="landing-sub">제목도 폴더도 고르지 않아도 돼요. 저장하면 분야와 갈래, 태그가 저절로 붙고, 글이 쌓일수록 서재가 자라요.</p>
    <ul class="landing-points">
      <li><span class="dot"></span>휴대폰과 PC의 기록이 하나로 이어져요</li>
      <li><span class="dot"></span>인터넷이 끊겨도 쓰고, 연결되면 알아서 맞춰요</li>
      <li><span class="dot"></span>로그아웃하기 전까지 로그인이 유지돼요</li>
    </ul>
    <div class="card landing-card">
      <div class="label" style="margin-bottom:12px">이메일로 시작하기</div>
      ${vLogin(true)}
    </div>
    <button class="btn-t landing-skip" ${act('skipLanding')}>로그인 없이 이 기기에서 먼저 써 볼게요</button>
  </div>
</div>`;
}

function render() {
  if (!S.ready) return;
  if (showLanding()) { morph(root, vLanding()); ta = null; return; }
  const wide = S.w >= 900;
  const draftLen = S.draft.trim().length;
  const navActive = S.tab;
  const tabs = [['write', '기록'], ['library', '서재'], ['timeline', '흐름'], ['search', '검색']];
  const cs = cats();
  const counts = Object.fromEntries(cs.map(c => [c.key, live().filter(n => n.cat === c.key).length]));
  const showNav = !wide && !(S.screen === 'write' && draftLen > 0);

  let screen = '';
  if (S.screen === 'write') screen = vWrite(wide, draftLen);
  else if (S.screen === 'library') screen = vLibrary(cs);
  else if (S.screen === 'category') screen = vCategory(cs);
  else if (S.screen === 'detail') screen = vDetail(cs);
  else if (S.screen === 'timeline') screen = vTimeline();
  else if (S.screen === 'search') screen = vSearch();

  const html = `
<div class="shell">
  ${x(wide, `<aside class="side">
    <div class="logo">생각서재</div>
    <nav>${each(tabs, ([k, l]) => `<button class="nav-item${navActive === k ? ' on' : ''}" ${act('go', k)}>${l}</button>`)}</nav>
    <div class="side-cats"><div class="label">분야</div>
      ${each(cs, c => `<div class="side-cat" ${act('openCat', c.key)}><span>${c.emoji} ${c.name}</span><span>${counts[c.key]}</span></div>`)}
    </div>
    ${vSyncDot()}
  </aside>`)}
  <input type="file" id="file-in" accept=".json,application/json" style="display:none">
  <main><div class="col">
    ${x(!wide, `<div class="mobile-logo"><span>생각서재</span>${vSyncDot(true)}</div>`)}
    ${screen}
  </div></main>
  ${x(showNav, `<nav class="tabbar">${each(tabs, ([k, l]) => `<button class="${navActive === k ? 'on' : ''}" ${act('go', k)}>${l}<i></i></button>`)}</nav>`)}
  ${x(S.phase !== 'idle', vSheet(cs))}
  ${x(S.toast, `<div class="toast" role="status">${esc(S.toast)}</div>`)}
</div>`;
  morph(root, html);
  ta = root.querySelector('textarea.draft');
}

function vSyncDot(compact) {
  if (!sync.configured()) return compact ? '' : `<div class="side-sync"><span class="dot" style="background:#B3AA9C"></span>이 기기에만 저장</div>`;
  const s = sync.session(); const st = sync.status();
  if (!s) return compact ? `<span class="hint" ${act('go', 'library')} style="font-family:var(--sans);font-weight:400">로그인 필요</span>` : `<div class="side-sync" ${act('go', 'library')}><span class="dot" style="background:#B3AA9C"></span>로그인하면 동기화돼요</div>`;
  const dirty = S.notes.some(n => n.dirty);
  const color = !navigator.onLine || st.state === 'offline' ? '#B3AA9C' : st.state === 'error' ? 'var(--warn)' : 'var(--accent)';
  const label = !navigator.onLine ? (dirty ? '오프라인 · 연결되면 맞출게요' : '오프라인') : st.state === 'syncing' ? '맞추는 중…' : st.state === 'error' ? '동기화 오류' : dirty ? '저장 대기 중' : '동기화됨';
  if (compact) return `<span class="hint" style="font-family:var(--sans);font-weight:400;display:flex;align-items:center;gap:6px"><span class="dot${st.state === 'syncing' ? ' pulse' : ''}" style="background:${color}"></span>${label}</span>`;
  return `<div class="side-sync"><span class="dot${st.state === 'syncing' ? ' pulse' : ''}" style="background:${color}"></span>${label}</div>`;
}

function vChecks(list, mode) {
  return each(list || [], (c, i) => `<div class="check">
    <div class="stack g6" style="flex:1;min-width:0">
      <div class="row g8 wrap" style="align-items:baseline">
        <span class="badge ${c.level === '오류 가능' ? 'err' : 'rec'}">${esc(c.level)}</span>
        ${x(c.quote, `<span class="quote">${esc(c.quote)}</span>`)}
      </div>
      <div style="font-size:14.5px;line-height:1.55">${esc(c.issue)}</div>
      ${x(c.note, `<div style="font-size:13.5px;line-height:1.55;color:var(--ink-2)">${esc(c.note)}</div>`)}
    </div>
    ${mode === 'draft' ? `<button class="btn-x" aria-label="이 항목 지우기" style="width:40px;height:40px" ${act('removeCheck', i)}>×</button>` : `<button class="ok-btn" ${act('confirmCheck', i)}>확인함</button>`}
  </div>`);
}

function vLogin(compact) {
  if (!sync.configured()) return '';
  if (S.loginStage === 'sent') return `<div class="stack g10">
    <div style="font-size:14px;line-height:1.6;color:var(--ink-2)"><b style="color:var(--ink)">${esc(S.email)}</b>로 로그인 메일을 보냈어요. 메일의 링크를 누르거나, 메일에 있는 숫자 코드를 입력하세요.</div>
    <div class="row g8"><input class="field" inputmode="numeric" autocomplete="one-time-code" placeholder="숫자 코드" value="${esc(S.code)}" data-in="code" data-kd="code">
    <button class="btn sm" ${act('verifyCode')} ${S.code.length >= 6 && !S.loginBusy ? '' : 'disabled'}>확인</button></div>
    <div class="row g12"><button class="btn-t" style="font-size:13px" ${act('loginReset')}>다른 주소로</button><button class="btn-t" style="font-size:13px" ${act('sendLink')}>메일 다시 보내기</button></div>
    ${x(S.loginErr, `<div style="font-size:13px;color:var(--warn-ink)">${esc(S.loginErr)}</div>`)}
  </div>`;
  return `<div class="stack g10">
    ${x(!compact, `<div style="font-size:14px;line-height:1.6;color:var(--ink-2)">로그인하면 휴대폰과 PC의 기록이 서버에 함께 저장돼요.</div>`)}
    <div class="row g8"><input class="field" type="email" autocomplete="email" placeholder="이메일 주소" value="${esc(S.email)}" data-in="email" data-kd="email">
    <button class="btn sm" ${act('sendLink')} ${S.loginBusy ? 'disabled' : ''}>${S.loginBusy ? '보내는 중…' : '로그인 메일 받기'}</button></div>
    ${x(S.loginErr, `<div style="font-size:13px;color:var(--warn-ink)">${esc(S.loginErr)}</div>`)}
  </div>`;
}

function vWrite(wide, draftLen) {
  const notes = sorted();
  const typing = draftLen > 0;
  const unexported = !sync.configured() && notes.length > 0 && (!S.lastExport || notes.some(n => (n.updatedAt || '') > S.lastExport));
  const daysSinceExport = S.lastExport ? Math.floor((Date.now() - new Date(S.lastExport)) / 864e5) : 99;
  const b = S.book;
  const bm = b ? bookMeta(b) : '';
  return `<section class="stack g20">
  <div class="date-label${typing ? ' typing' : ''}">${todayLabel()}</div>
  ${x(S.bookStatus === 'loading' && !S.bookDismissed, `<div class="row g10" style="font-size:13.5px;color:var(--ink-3);padding:2px 0"><span class="dot pulse"></span>책 정보를 찾는 중…</div>`)}
  ${x(S.bookStatus === 'found' && b && !S.bookDismissed, `<div class="card book-card" style="border-radius:12px">
    <div class="book-shape"></div>
    <div class="stack g4" style="flex:1;min-width:0">
      <div class="serif" style="font-size:16.5px;font-weight:700;line-height:1.4">『${esc(b && b.title)}』</div>
      ${x(bm, `<div style="font-size:13.5px;color:var(--ink-2);line-height:1.5">${esc(bm)}</div>`)}
      <div style="font-size:12px;color:var(--ph)">${b && b.ai ? 'AI가 찾은 정보예요. 다르면 지워주세요.' : '책 정보는 AI 연결 시 자동으로 채워져요.'}</div>
    </div>
    <button class="btn-x" aria-label="책 정보 지우기" ${act('dismissBook')}>×</button>
  </div>`)}
  <textarea class="draft" data-in="draft" data-kd="draft" placeholder="떠오르는 생각을 그대로 적어보세요." aria-label="생각 기록">${esc(S.draft)}</textarea>
  ${x(S.voiceErr && !S.listening, `<div class="banner err">${esc(S.voiceErr)}<button class="btn-x" style="color:var(--warn-ink);width:40px;height:40px" aria-label="닫기" ${act('closeVoiceErr')}>×</button></div>`)}
  ${x(S.checkStatus === 'loading', `<div class="banner plain loading g10"><span class="dot pulse"></span>사실관계를 확인할 부분을 찾는 중…</div>`)}
  ${x(S.checkStatus === 'unavailable' || S.checkStatus === 'error', `<div class="banner plain">${S.checkStatus === 'unavailable' ? 'AI 검토는 로그인하고 온라인일 때 쓸 수 있어요.' : '검토하지 못했어요. 잠시 후 다시 시도해 주세요.'}<button class="btn-x" style="width:40px;height:40px" aria-label="닫기" ${act('closeCheck')}>×</button></div>`)}
  ${x(S.checkStatus === 'done' && S.checks && !S.checks.length, `<div class="banner ok">따로 확인할 내용이 없어요.<button class="btn-x" style="color:var(--accent);width:40px;height:40px" aria-label="닫기" ${act('closeCheck')}>×</button></div>`)}
  ${x(S.checkStatus === 'done' && S.checks && S.checks.length, `<div class="card checks stack">
    <div class="row between g10" style="padding-right:10px"><span style="font-size:14px;font-weight:600">확인해 볼 내용 ${(S.checks || []).length}</span><button class="btn-t" style="font-size:13px;color:var(--ink-3)" ${act('closeCheck')}>모두 닫기</button></div>
    <div style="font-size:12.5px;color:var(--ink-3);line-height:1.5;padding:4px 10px 6px 0">AI가 아는 범위의 검토예요. 고치지 않고 저장하면 이 목록이 글에 함께 남아요.</div>
    ${vChecks(S.checks, 'draft')}
  </div>`)}
  <div class="write-foot">
    <div class="row g12" style="min-width:0">
      ${x(!wide, S.listening ? `<button class="mic on" aria-label="음성 입력 멈추기" ${act('toggleVoice')}><span></span></button>` : `<button class="mic" aria-label="음성으로 기록" ${act('toggleVoice')}>${micSvg}</button>`)}
      ${S.listening ? `<span class="hint rec">듣고 있어요… 말을 마치면 ■</span>` : `<span class="hint">${typing ? `${draftLen}자${wide ? ` · ${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}↵ 저장` : ''}` : '제목도 분류도 필요 없어요. 쓰기만 하세요.'}</span>`}
    </div>
    ${typing && S.phase !== 'classifying' ? `<div class="row g6" style="flex-shrink:0"><button class="btn-o" ${act('runCheck')}>${S.checkStatus === 'loading' ? '검토 중…' : 'AI 검토'}</button><button class="btn" ${act('save')}>저장</button></div>` : `<button class="btn" disabled>저장</button>`}
  </div>
  ${x(!typing && notes.length === 0, `<div class="card stack g12" style="margin-top:32px;padding:18px 20px">
    ${sync.configured()
      ? (sync.session() ? `<div style="font-size:14.5px;line-height:1.6">${esc(sync.session().user && sync.session().user.email || '')} 계정으로 동기화 중이에요. 첫 생각을 남겨 보세요.</div>` : vLogin(false))
      : `<div style="font-size:14.5px;line-height:1.6">기록은 이 기기의 브라우저에 안전하게 저장돼요. 이전에 내려받은 백업 파일이 있으면 불러오세요.</div>`}
    <div class="row g8 wrap"><button class="btn-o sm" ${act('importClick')}>백업 불러오기</button></div>
  </div>`)}
  ${x(!typing && unexported && daysSinceExport >= 3, `<div class="notice caution" style="margin-top:28px"><span style="flex:1;min-width:200px">이 기기에만 저장돼 있어요. 브라우저 데이터를 지우면 사라질 수 있으니 가끔 백업을 내려받아 두세요.</span><button class="btn xs" ${act('exportData')}>지금 백업</button></div>`)}
  ${x(!typing && notes.length > 0, `<div class="stack g4" style="margin-top:40px">
    <div class="label" style="margin-bottom:6px">최근에 남긴 생각</div>
    ${each(notes.slice(0, 3), n => `<div class="recent-row" ${act('openNote', n.id)}><span class="when">${rel(n.date)}</span><span class="what">${esc(n.summary)}</span></div>`)}
  </div>`)}
</section>`;
}

function vEditor(n, cs, filled) {
  const c = cs.find(x => x.key === n.cat);
  const idA = ` data-id="${esc(n.id)}"`;
  return `<div class="editor${filled ? ' filled' : ''}">
    <div class="stack g8"><div class="label" style="letter-spacing:0.06em">분야</div>
      <div class="row g6 wrap">${each(cs.filter(o => !o.virtual), o => `<button class="chip${o.key === n.cat ? ' on' : ''}" ${act('pickCat', o.key, idA)}>${o.emoji} ${o.name}</button>`)}</div></div>
    <div class="stack g8"><div class="label" style="letter-spacing:0.06em">세부 갈래</div>
      <div class="row g6 wrap">
        ${each(c ? c.subs : [], o => `<button class="chip${o.name === n.sub ? ' on' : ''}" ${act('pickSub', o.name, idA)}>${esc(o.name)}</button>`)}
        <input class="dashed w" placeholder="+ 새 갈래 이름" value="${esc(S.newSub)}" data-in="newSub" data-kd="newSub"${idA}>
        ${x(S.newSub.trim(), `<button class="chip ink on" ${act('addSub', n.id)}>추가</button>`)}
      </div></div>
  </div>`;
}

function related(dn) {
  return live().filter(n => n.id !== dn.id).map(n => {
    const shared = n.tags.filter(t => dn.tags.includes(t)); const sameSub = n.cat === dn.cat && n.sub === dn.sub;
    return { n, score: shared.length * 2 + (sameSub ? 1 : 0), reason: shared.length ? `같은 태그 #${shared[0]}` : `같은 갈래 · ${n.sub}` };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.n.date.localeCompare(a.n.date));
}

function vSheet(cs) {
  const n = findNote(S.resId);
  const inner = S.phase === 'classifying' || !n
    ? `<div class="row g10" style="padding:20px 0 28px;font-size:15px;color:var(--ink-2)"><span class="dot pulse" style="width:8px;height:8px"></span>읽고 분류하는 중…</div>`
    : (() => {
      const c = catOf(n.cat);
      const rel3 = related(n).slice(0, 3);
      const idA = ` data-id="${esc(n.id)}"`;
      return `<div style="font-size:13px;color:var(--ink-2)">저장했어요 · 이렇게 정리했어요</div>
      <div class="stack g12">
        <div class="cat-row" ${act('toggleCat')}><span class="path">${c.emoji} ${c.name} › ${esc(n.sub)}</span><span class="link-accent">${S.editing ? '닫기' : '바꾸기'}</span></div>
        ${x(S.editing, vEditor(n, cs, false))}
        ${x(S.resNew, `<div class="row g6" style="font-size:13px;color:var(--accent)"><span class="dot"></span>새 갈래가 자랐어요</div>`)}
        <div class="row g6 wrap">
          ${each(n.tags, t => `<button class="tag-chip" ${act('removeTag', t, idA)}>#${esc(t)} <span>×</span></button>`)}
          <input class="dashed" placeholder="+ 추가" value="${esc(S.newTag)}" data-in="newTag" data-kd="newTag">
        </div>
        ${n.book ? `<div style="font-size:14px;line-height:1.5">📖 『${esc(n.book.title)}』 <span style="color:var(--ink-2)">${esc(bookMeta(n.book))}</span></div>` : ''}
        ${x(!isShort(n.body), `<div class="serif" style="font-size:15.5px;line-height:1.6;color:var(--ink-2)">“${esc(n.summary)}”</div>`)}
        ${x(n.checks && n.checks.length, `<div style="font-size:13px;color:var(--caution)">확인할 내용 ${(n.checks || []).length}개를 글에 함께 남겼어요.</div>`)}
        ${x(S.resNote, `<div style="font-size:13px;color:var(--ink-3)">${esc(S.resNote)}</div>`)}
      </div>
      ${x(rel3.length, `<div class="row g8" style="font-size:13px;color:var(--accent);border-top:1px solid var(--line);padding-top:14px;line-height:1.5" ${act('openNote', rel3[0] ? rel3[0].n.id : '')}><span class="dot"></span>관련된 생각 ${rel3.length}개 — 「${esc(rel3[0] ? rel3[0].n.summary : '')}」${rel3.length > 1 ? ' 외' : ''}</div>`)}
      <button class="btn" style="padding:15px;min-height:50px" ${act('dismiss')}>좋아요</button>`;
    })();
  return `<div class="sheet-wrap"><div class="sheet-bg" ${S.phase === 'done' ? act('dismiss') : ''}></div><div class="sheet" role="dialog" aria-label="저장 결과"><div class="handle"></div>${inner}</div></div>`;
}

function vLibrary(cs) {
  const all = sorted();
  const lib = cs.map(c => {
    const ns = all.filter(n => n.cat === c.key);
    return { ...c, ns, count: ns.length, last: ns[0] ? rel(ns[0].date) : '—', lastDate: ns[0] ? ns[0].date + (ns[0].createdAt || '') : '', latest: ns[0] ? ns[0].summary : '', latestId: ns[0] && ns[0].id,
      subs: c.subs.map(sb => ({ ...sb, count: ns.filter(n => n.sub === sb.name).length, isNew: daysAgo(sb.born) <= 14 })) };
  }).sort((a, b) => b.lastDate.localeCompare(a.lastDate));
  const maxC = Math.max(1, ...lib.map(c => c.count));
  const openKey = S.shelfKey || lib[0].key;
  const oc = lib.find(c => c.key === openKey) || lib[0];
  const subCount = cs.reduce((a, c) => a + c.subs.length, 0);
  const subtitle = all.length ? `생각 ${all.length}편이 ${cs.length}개 분야, ${subCount}개 갈래로 저절로 정리되었어요.` : '아직 비어 있어요. 기록을 남기면 분야 아래 갈래가 저절로 자라요.';
  const subA = (c, sb) => `${act('openCat', c.key)} data-sub="${esc(sb.name)}"`;

  let body = '';
  if (S.libView === 'shelf') body = `<div class="stack g28">
    <div class="stack"><div class="shelf">
      ${each(lib, c => `<button class="spine${c.key === openKey ? ' on' : ''}" style="width:${38 + Math.round(c.count / maxC * 20)}px;height:${130 + Math.round(c.count / maxC * 120)}px;background:${catColor(c.hue)}" ${act('shelf', c.key)} aria-label="${c.name} ${c.count}편"><span class="nm">${c.name}</span><span class="ct">${c.count}</span></button>`)}
    </div><div class="shelf-board"></div></div>
    <div class="stack">
      <div class="row between" style="align-items:baseline;padding-bottom:10px"><span class="serif" style="font-size:21px;font-weight:700">${oc.emoji} ${oc.name}의 목차</span><span style="font-size:13px;color:var(--accent);padding:6px 0" ${act('openCat', oc.key)}>전체 ${oc.count}편 →</span></div>
      ${each(oc.subs, (sb, i) => `<div class="toc-row" ${subA(oc, sb)}><span class="row g10"><span style="color:var(--ink-3);width:28px">${i + 1}장</span>${esc(sb.name)}${x(sb.isNew, '<span class="new-badge">새 갈래</span>')}</span><span style="color:var(--ink-3);font-size:13px">${sb.count}</span></div>`)}
      ${x(!oc.subs.length, `<div style="border-top:1px solid var(--line);padding:16px 0;font-size:14.5px;color:var(--ink-3)">아직 갈래가 없어요. 이 분야의 글이 쌓이면 목차가 생겨요.</div>`)}
      ${x(oc.latest, `<div class="stack g6" style="border-top:1px solid var(--line);padding-top:16px" ${act('openNote', oc.latestId)}><span style="font-size:12px;color:var(--ink-3);letter-spacing:0.06em">가장 최근 페이지 · ${oc.last}</span><span class="serif" style="font-size:16.5px;line-height:1.6">“${esc(oc.latest)}”</span></div>`)}
    </div></div>`;
  else if (S.libView === 'card') body = `<div class="cards">${each(lib, c => `<div class="cat-card" ${act('openCat', c.key)}>
      <div class="row between" style="align-items:baseline"><span class="serif" style="font-size:21px;font-weight:700">${c.emoji} ${c.name}</span><span style="font-size:13px;color:var(--ink-3)">${c.last}</span></div>
      <div class="serif" style="font-size:15px;color:var(--ink-2);line-height:1.55;min-height:46px">${esc(c.latest)}</div>
      <div class="row g6 wrap">${each(c.subs, sb => `<span class="sub-pill" ${subA(c, sb)}>${x(sb.isNew, '<span class="dot" style="width:5px;height:5px"></span>')}${esc(sb.name)} <span style="color:var(--ink-3)">${sb.count}</span></span>`)}</div>
      <div style="font-size:13px;color:var(--ink-3);border-top:1px solid var(--line);padding-top:12px">${c.count}편</div>
    </div>`)}</div>`;
  else body = `<div class="stack">${each(lib, c => `<div class="stack g6" style="border-bottom:1px solid var(--line);padding:18px 0">
      <div class="row between" style="align-items:baseline;padding:4px 0" ${act('openCat', c.key)}><span class="serif" style="font-size:19px;font-weight:700">${c.emoji} ${c.name} <span style="font-family:var(--sans);font-size:13px;font-weight:400;color:var(--ink-3);margin-left:4px">${c.count}</span></span><span style="font-size:13px;color:var(--ink-3)">${c.last}</span></div>
      <div class="stack" style="margin-left:9px;border-left:1px solid var(--tree)">${each(c.subs, sb => `<div class="tree-sub" ${subA(c, sb)}><span class="row g8">${esc(sb.name)}${x(sb.isNew, '<span class="new-badge">새 갈래</span>')}</span><span style="color:var(--ink-3);font-size:13px">${sb.count}</span></div>`)}</div>
    </div>`)}</div>`;

  return `<section class="stack g28">
  <div class="row between wrap g16" style="align-items:flex-end">
    <div class="stack g8"><h1 class="title">서재</h1><div style="font-size:14.5px;color:var(--ink-2);line-height:1.6">${subtitle}</div></div>
    <div class="seg">${each([['shelf', '책장'], ['card', '카드'], ['tree', '트리']], ([k, l]) => `<button class="${S.libView === k ? 'on' : ''}" ${act('libView', k)}>${l}</button>`)}</div>
  </div>
  ${body}
  ${vCatManager()}
  ${vManage()}
</section>`;
}

function vCatManager() {
  const list = getCats();
  const count = key => live().filter(n => n.cat === key).length;
  const head = `<div class="row between" style="align-items:center">
      <div class="label">분야 관리</div>
      <button class="link-accent" ${act('toggleCatMgr')}>${S.catMgr ? '닫기' : '분야 추가·삭제'}</button>
    </div>`;
  if (!S.catMgr) return `<div class="cat-mgr">${head}<div style="font-size:13.5px;color:var(--ink-2);line-height:1.6">${list.map(c => `${c.emoji} ${c.name}`).join(' · ')}</div></div>`;
  const rows = each(list, c => {
    const n = count(c.key);
    if (S.delCat === c.key) {
      const others = list.filter(o => o.key !== c.key);
      return `<div class="cat-mgr-row del">
        <div style="font-size:14.5px;font-weight:600">${c.emoji} ${c.name} 분야를 지울까요?</div>
        ${n ? `<div style="font-size:13px;color:var(--ink-2);line-height:1.55">이 분야의 글 ${n}편을 옮길 분야를 골라 주세요. 갈래와 태그는 그대로 따라가요.</div>
        <div class="row g6 wrap">${each(others, o => `<button class="chip${S.delTarget === o.key ? ' on' : ''}" ${act('delTarget', o.key)}>${o.emoji} ${o.name}</button>`)}</div>`
        : `<div style="font-size:13px;color:var(--ink-2)">이 분야에는 글이 없어요.</div>`}
        <div class="row g8" style="justify-content:flex-end">
          <button class="btn-o" style="min-height:40px;padding:8px 16px" ${act('cancelDeleteCat')}>취소</button>
          <button class="btn xs" style="background:var(--warn)" ${act('deleteCat')}>${n ? '옮기고 삭제' : '삭제'}</button>
        </div>
      </div>`;
    }
    return `<div class="cat-mgr-row">
      <span class="row g10"><span class="swatch" style="background:${catColor(c.hue)}"></span>${c.emoji} ${c.name}<span style="color:var(--ink-3);font-size:13px">${n}편</span></span>
      <button class="btn-danger" style="min-height:40px;padding:6px 8px" aria-label="${c.name} 분야 삭제" ${act('askDeleteCat', c.key)} ${list.length <= 1 ? 'disabled' : ''}>삭제</button>
    </div>`;
  });
  return `<div class="cat-mgr">
    ${head}
    <div style="font-size:12.5px;color:var(--ink-3);line-height:1.6">저장할 때 AI가 이 분야들 중에서 골라요. 갈래(세부 분류)는 글에 맞춰 저절로 자라요.</div>
    <div class="stack">${rows}</div>
    ${list.length < MAX_CATS ? `<div class="row g8 wrap" style="margin-top:4px">
      <input class="field" style="flex:0 0 72px;text-align:center" maxlength="4" placeholder="📁" aria-label="분야 이모지" value="${esc(S.newCatEmoji)}" data-in="newCatEmoji">
      <input class="field" style="min-width:140px" maxlength="10" placeholder="새 분야 이름 (예: 신앙, 여행)" aria-label="새 분야 이름" value="${esc(S.newCatName)}" data-in="newCatName" data-kd="newCatName">
      <button class="btn sm" ${act('addCat')} ${S.newCatName.trim() ? '' : 'disabled'}>추가</button>
    </div>` : `<div style="font-size:13px;color:var(--ink-3)">분야는 ${MAX_CATS}개까지 만들 수 있어요.</div>`}
    ${x(S.catErr, `<div style="font-size:13px;color:var(--warn-ink)">${esc(S.catErr)}</div>`)}
    ${x(sync.session() && sync.catsSupported() === false, `<div class="notice caution" style="font-size:12.5px">분야 목록은 아직 이 기기에만 저장돼요. 다른 기기와 맞추려면 Supabase에서 <b>supabase/add-categories.sql</b>을 한 번 실행해 주세요.</div>`)}
    <button class="btn-t" style="align-self:flex-start;font-size:12.5px;color:var(--ink-3)" ${act('resetCats')}>기본 분야 6개로 되돌리기</button>
  </div>`;
}

function vManage() {
  const s = sync.session(); const st = sync.status();
  const month = monthKey(); const calls = S.aiUsage[month] || 0;
  let syncBlock;
  if (!sync.configured()) syncBlock = `<div style="font-size:13.5px;color:var(--ink-2);line-height:1.6">지금은 <b>이 기기에만</b> 저장돼요. 휴대폰과 PC를 함께 쓰려면 서버 동기화를 켜세요(설치 안내서 참고). AI 분류도 서버 연결 후에 쓸 수 있고, 그 전에는 간단한 규칙으로 분류해요.</div>`;
  else if (!s) syncBlock = vLogin(false);
  else syncBlock = `<div class="stack g8">
    <div style="font-size:13.5px;color:var(--accent);display:flex;align-items:center;gap:8px"><span class="dot${st.state === 'syncing' ? ' pulse' : ''}"></span>${esc(s.user && s.user.email || '로그인됨')} · ${st.state === 'syncing' ? '맞추는 중…' : st.at ? `마지막 동기화 ${new Date(st.at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}` : '동기화 대기'}</div>
    ${x(st.error, `<div style="font-size:13px;color:var(--warn-ink)">${esc(st.error)}</div>`)}
    <div style="font-size:12.5px;color:var(--ink-3)">AI 정리 · 이번 달 ${calls}회 호출${S.lastProvider ? ` · ${S.lastProvider === 'anthropic' ? 'Claude' : 'Gemini'}` : ''}</div>
  </div>`;
  return `<div class="manage">
    <div class="label">내 기록 관리</div>
    ${syncBlock}
    <div class="row g8 wrap">
      ${x(s, `<button class="btn xs" ${act('syncNow')}>지금 동기화</button>`)}
      <button class="btn-o sm" ${act('exportData')}>백업 내보내기</button>
      <button class="btn-o sm" ${act('importClick')}>백업 불러오기</button>
      ${x(s, `<button class="btn-t" style="font-size:13.5px;padding:10px 8px" ${act('signOut')}>로그아웃</button>`)}
      <button class="btn-danger" ${act('resetAll')}>전체 초기화</button>
    </div>
    ${x(sync.configured(), `<div style="font-size:12px;color:var(--ink-3);line-height:1.6">Gemini 무료 등급은 입력한 글이 서비스 개선에 쓰일 수 있어요. 육아·개인 기록이 많다면 유료 등급이나 Claude로 바꾸는 걸 권해요.</div>`)}
  </div>`;
}

function noteRow(n, { showPath } = {}) {
  const c = catOf(n.cat);
  return `<div class="note-row" ${act('openNote', n.id)}>
    <div class="meta">${fmt(n.date)} · ${showPath ? `${c.emoji} ${c.name} › ` : ''}${esc(n.sub)}</div>
    ${x(n.book, `<div style="font-size:13px;color:var(--ink-2)">📖 『${esc(n.book && n.book.title)}』${n.book && n.book.author ? ' ' + esc(n.book.author) : ''}</div>`)}
    <div class="sum">${esc(n.summary)}</div>
    <div class="clamp2">${esc(n.body.replace(/\n/g, ' '))}</div>
    ${x(n.tags.length && !showPath, `<div class="tags">${each(n.tags, t => `<span>#${esc(t)}</span>`)}</div>`)}
  </div>`;
}

function vCategory(cs) {
  const c = cs.find(x => x.key === S.catKey) || cs[0];
  const all = sorted().filter(n => n.cat === c.key);
  const list = S.subFilter ? all.filter(n => n.sub === S.subFilter) : all;
  const chips = [{ name: '', label: `전체 ${all.length}` }, ...c.subs.map(sb => ({ name: sb.name, label: `${sb.name} ${all.filter(n => n.sub === sb.name).length}` }))];
  return `<section class="stack g24">
  <button class="btn-t" style="align-self:flex-start" ${act('back')}>← ${S.depth > 0 && S.from ? esc(S.from) : '서재'}</button>
  <div class="stack g8"><h1 class="title" style="font-size:32px">${c.emoji} ${c.name}</h1><div style="font-size:14px;color:var(--ink-2)">${all.length}편 · 마지막 기록 ${all[0] ? rel(all[0].date) : '—'}</div></div>
  <div class="row g6 wrap">${each(chips, o => `<button class="chip f ink${(S.subFilter || '') === o.name ? ' on' : ''}" ${act('subFilter', o.name)}>${esc(o.label)}</button>`)}</div>
  <div style="border-top:1px solid var(--line)">${list.length ? each(list, n => noteRow(n)) : `<div style="padding:24px 0;font-size:14.5px;color:var(--ink-3)">아직 이 분야의 글이 없어요.</div>`}</div>
</section>`;
}

function vDetail(cs) {
  const n = findNote(S.noteId);
  if (!n) return `<section class="stack g24"><button class="btn-t" style="align-self:flex-start" ${act('back')}>← 돌아가기</button><div class="muted">글을 찾을 수 없어요.</div></section>`;
  const c = catOf(n.cat);
  const rels = related(n).slice(0, 4);
  return `<article class="stack g28">
  <div class="row between g12">
    <button class="btn-t" ${act('back')}>← ${esc(S.depth > 0 && S.from ? S.from : '서재')}</button>
    ${x(!S.bodyEditing, `<div class="row g6">
      <button class="btn-danger" style="min-height:40px;padding:8px 12px" ${act('deleteNote')}>삭제</button>
      <button class="btn-o sm" style="min-height:40px;padding:8px 16px" ${act('startBodyEdit')}>글 수정</button>
    </div>`)}
  </div>
  <div class="stack g10">
    <div class="row g8 wrap" style="font-size:13.5px;color:var(--ink-2)"><span>${c.emoji} ${c.name} › ${esc(n.sub)}</span><span style="color:#B3AA9C">·</span><span>${fmt(n.date)}</span><button class="link-accent" style="padding-left:4px" ${act('toggleDetEdit')}>${S.detailEditing ? '닫기' : '분류 수정'}</button></div>
    ${x(S.detailEditing, vEditor(n, cs, true))}
    <div class="row g10 wrap">${each(n.tags, t => `<span style="font-size:14px;color:var(--accent)">#${esc(t)}</span>`)}</div>
  </div>
  ${x(n.book, `<div class="row g16" style="border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0">
    <div class="book-shape lg"></div>
    <div class="stack g4" style="min-width:0"><div class="serif" style="font-size:18px;font-weight:700;line-height:1.4">『${esc(n.book && n.book.title)}』</div><div style="font-size:13.5px;color:var(--ink-2);line-height:1.5">${esc(n.book ? bookMeta(n.book) : '')}</div></div>
  </div>`)}
  ${S.bodyEditing ? `<div class="stack g12">
    <textarea class="edit-body" data-in="bodyDraft" data-kd="bodyDraft" aria-label="글 수정">${esc(S.bodyDraft)}</textarea>
    <div class="row between g8 wrap">
      <button class="btn-danger" style="padding:10px 4px" ${act('deleteNote')}>글 삭제</button>
      <div class="row g8"><button class="btn-o" style="min-height:46px;padding:12px 18px" ${act('cancelBodyEdit')}>취소</button>${x(S.bodyDraft.trim(), `<button class="btn" style="min-height:46px;padding:12px 24px;font-size:14.5px" ${act('saveBody')}>수정 저장</button>`)}</div>
    </div>
  </div>` : `<div class="stack g18">
    ${x(n.edited, `<div style="font-size:12.5px;color:var(--ink-3)">${n.edited ? rel(n.edited) : ''} 수정</div>`)}
    ${each(n.body.split('\n').filter(p => p.trim()), p => `<p class="para">${esc(p)}</p>`)}
  </div>`}
  ${x(n.checks && n.checks.length, `<div class="card checks stack"><div class="label" style="color:var(--ink-2);padding-bottom:8px">아직 확인하지 않은 내용</div>${vChecks(n.checks, 'note')}</div>`)}
  ${x(!isShort(n.body), `<div class="summary-box"><div class="label" style="color:var(--ink-2)">${n.aiPending && sync.configured() ? '한 줄 요약 · AI 정리 대기 중' : n.aiPending ? '한 줄 요약' : 'AI 한 줄 요약'}</div><div style="font-size:16px;line-height:1.6">${esc(n.summary)}</div></div>`)}
  <div class="stack g4" style="margin-top:12px">
    <h2 class="serif" style="margin:0 0 8px;font-size:20px;font-weight:700">이 글과 관련된 생각</h2>
    ${rels.length ? each(rels, r => { const rc = catOf(r.n.cat); return `<div class="rel-row" ${act('openNote', r.n.id)}>
      <div class="row g8 wrap" style="font-size:12.5px;color:var(--ink-3)"><span class="reason">${esc(r.reason)}</span><span>${rc.emoji} ${rc.name} › ${esc(r.n.sub)} · ${fmt(r.n.date)}</span></div>
      <div class="serif" style="font-size:16.5px;line-height:1.5">${esc(r.n.summary)}</div></div>`; }) : `<div style="font-size:14px;color:var(--ink-3);padding:8px 0">아직 이어진 생각이 없어요. 글이 쌓이면 같은 태그·갈래끼리 이어져요.</div>`}
  </div>
</article>`;
}

function vTimeline() {
  const all = sorted();
  const mNotes = all.filter(n => n.date.startsWith(monthKey()));
  let month = '';
  if (mNotes.length) {
    const byCat = cats().map(c => ({ c, count: mNotes.filter(n => n.cat === c.key).length })).filter(v => v.count).sort((a, b) => b.count - a.count);
    const tagCount = {}; mNotes.forEach(n => n.tags.forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
    const topTag = Object.entries(tagCount).sort((a, b) => b[1] - a[1])[0];
    const newSubs = []; cats().forEach(c => c.subs.forEach(sb => { if (sb.born.startsWith(monthKey())) newSubs.push(`${c.name} › ${sb.name}`); }));
    month = `<div class="month">
      <div class="stack g8"><div class="label">${pd(todayS()).getMonth() + 1}월 돌아보기</div>
        <div class="serif pretty" style="font-size:22px;line-height:1.5">이번 달에는 <b>${byCat[0].c.name}</b>에 대해 가장 많이 생각했어요.${topTag ? ` 특히 <b>#${esc(topTag[0])}</b>${/[가-힣]/.test(topTag[0].slice(-1)) && (topTag[0].slice(-1).charCodeAt(0) - 0xAC00) % 28 ? '이' : '가'} ${topTag[1]}번 등장했어요.` : ''}</div></div>
      ${vNet(mNotes)}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;border-top:1px solid var(--line);padding-top:18px">
        <div class="stack g4"><span style="font-size:12px;color:var(--ink-3)">이번 달 기록</span><span style="font-size:16px">${mNotes.length}편</span></div>
        <div class="stack g4"><span style="font-size:12px;color:var(--ink-3)">새로 자란 갈래</span><span style="font-size:16px">${esc(newSubs.join(', ') || '없음')}</span></div>
      </div>
    </div>`;
  }
  const groups = [];
  all.forEach(n => { let g = groups[groups.length - 1]; if (!g || g.date !== n.date) { const d = pd(n.date); g = { date: n.date, day: `${d.getMonth() + 1}.${d.getDate()}`, dow: DOW[d.getDay()] + '요일', notes: [] }; groups.push(g); } g.notes.push(n); });
  return `<section class="stack g32">
  <h1 class="title">흐름</h1>
  ${x(!all.length, `<div class="serif" style="font-size:18px;line-height:1.7;color:var(--ink-2)">아직 흐름이 없어요. 생각을 몇 개 남기면 날짜순 흐름과 한 달 돌아보기가 여기에 생겨요.</div>`)}
  ${month}
  <div class="stack">${each(groups.slice(0, 120), g => `<div class="tl-group">
    <div class="tl-day"><span class="serif" style="font-size:18px;font-weight:700">${g.day}</span><span style="font-size:12px;color:var(--ink-3)">${g.dow}</span></div>
    <div class="tl-list">${each(g.notes, n => { const c = catOf(n.cat); return `<div class="tl-item" ${act('openNote', n.id)}><div style="font-size:12.5px;color:var(--ink-3)">${c.emoji} ${c.name} › ${esc(n.sub)}</div><div class="serif" style="font-size:17px;line-height:1.5">${esc(n.summary)}</div></div>`; })}</div>
  </div>`)}</div>
</section>`;
}

function vNet(mNotes) {
  const { nodes, edges } = layoutNet(mNotes);
  const selIdx = nodes.findIndex(n => n.id === S.netSel);
  const near = new Set();
  if (selIdx >= 0) { near.add(selIdx); edges.forEach(e => { if (e.a === selIdx) near.add(e.b); if (e.b === selIdx) near.add(e.a); }); }
  const maxC = Math.max(1, ...nodes.filter(n => n.type === 'cat').map(n => n.count));
  const maxT = Math.max(1, ...nodes.filter(n => n.type === 'tag').map(n => n.count));
  const maxW = Math.max(1, ...edges.map(e => e.w));
  const pct = v => (v * 100).toFixed(2) + '%';
  const lines = each(edges, e => {
    const on = selIdx >= 0 && (e.a === selIdx || e.b === selIdx); const A = nodes[e.a], B = nodes[e.b];
    return `<line x1="${pct(A.x)}" y1="${pct(A.y)}" x2="${pct(B.x)}" y2="${pct(B.y)}" style="stroke:${on ? '#2F5A4B' : selIdx >= 0 ? '#E6E1D7' : '#CFC7B8'};stroke-width:${(1 + 2 * e.w / maxW) + (on ? 0.5 : 0)};stroke-linecap:round"></line>`;
  });
  const dots = each(nodes, (n, i) => {
    const on = selIdx < 0 || near.has(i), isSel = i === selIdx;
    if (n.type === 'cat') {
      const c = catOf(n.key); const sz = Math.round(48 + 30 * n.count / maxC);
      return `<button class="net-cat" aria-label="${c.name}" style="left:${pct(n.x)};top:${pct(n.y)};width:${sz}px;height:${sz}px;background:${catColor(c.hue)};opacity:${on ? 1 : 0.28};box-shadow:${isSel ? '0 0 0 3px #F5F2EB, 0 0 0 5px #2B2722' : 'none'}" ${act('netSel', n.id)}>${c.name}<span>${n.count}</span></button>`;
    }
    const sz = Math.round(8 + 8 * n.count / maxT);
    return `<button class="net-tag" style="left:${pct(n.x)};top:${pct(n.y)};transform:translate(-50%,-${sz / 2}px);opacity:${on ? 1 : 0.35}" ${act('netSel', n.id)}><i style="width:${sz}px;height:${sz}px;background:${isSel ? '#2B2722' : '#2F5A4B'};box-shadow:${isSel ? '0 0 0 3px #E3EBE4' : 'none'}"></i><b style="color:${on ? '#2B2722' : '#857D72'}">#${esc(n.key)}</b></button>`;
  });
  let sel = `<div style="font-size:13px;color:var(--ink-3);line-height:1.5">원은 분야, 점은 태그예요. 같은 태그를 가진 분야끼리 이어져요. 눌러서 이어진 생각을 보세요.</div>`;
  if (selIdx >= 0) {
    const n = nodes[selIdx];
    let label, list;
    if (n.type === 'cat') { const c = catOf(n.key); label = `${c.emoji} ${c.name}`; list = mNotes.filter(m => m.cat === n.key); }
    else { label = '#' + n.key; list = mNotes.filter(m => m.tags.includes(n.key)); }
    sel = `<div class="stack" style="border-top:1px solid var(--line);padding-top:12px">
      <div class="row between g10"><span style="font-size:14px;font-weight:600">${esc(label)} <span style="font-weight:400;color:var(--ink-3)">· 이번 달 ${list.length}편</span></span><button class="btn-t" style="font-size:13px;color:var(--ink-3)" ${act('netSel', n.id)}>닫기</button></div>
      ${each(list, m => `<div class="row g12" style="padding:12px 0;border-top:1px solid var(--hover);align-items:baseline" ${act('openNote', m.id)}><span style="font-size:12.5px;color:var(--ink-3);flex-shrink:0">${shortDate(m.date)}</span><span class="serif" style="font-size:15.5px;line-height:1.5">${esc(m.summary)}</span></div>`)}
    </div>`;
  }
  return `<div class="stack g12"><div class="net"><svg aria-hidden="true">${lines}</svg>${dots}</div>${sel}</div>`;
}

function vSearch() {
  const q = S.query.trim();
  const isNL = /더라|했었|썼지|언제|뭐라|어떻게|\?|？|있었/.test(q);
  const all = sorted();
  let results = [];
  if (q) { const k = q.replace(/^#/, ''); results = isNL ? nlScore(q, all) : all.filter(n => [n.body, n.summary, n.tags.join(' '), n.sub, catOf(n.cat).name, n.book ? n.book.title : ''].join(' ').includes(k)); }
  const ansNotes = S.answer ? S.answer.ids.map(findNote).filter(Boolean) : [];
  return `<section class="stack g24">
  <h1 class="title">검색</h1>
  <div class="search-bar">
    <input type="search" enterkeyhint="search" value="${esc(S.query)}" data-in="query" data-kd="query" placeholder="키워드, 또는 “그때 ~에 대해 뭐라고 썼더라?”" aria-label="검색">
    ${x(isNL, `<button class="btn xs accent" style="white-space:nowrap" ${act('ask')}>물어보기</button>`)}
  </div>
  ${x(!q, `<div class="stack g10"><div class="label">이렇게 물어봐도 돼요</div>${each(['그때 학습부진 중재에 대해 뭐라고 썼더라?', '아이 시간 개념 얘기 언제 썼지?', '#역사적사고'], l => `<div class="example" ${act('example', l)}>${esc(l)}</div>`)}</div>`)}
  ${x(S.aiLoading, `<div class="card" style="padding:18px 20px;font-size:15px;color:var(--ink-2);display:flex;gap:10px;align-items:center"><span class="dot pulse"></span>기록을 뒤적이는 중…</div>`)}
  ${x(S.answer, `<div class="card stack g14" style="border-radius:16px;padding:22px">
    <div class="label">기록에서 찾은 답</div>
    <div class="serif pretty" style="font-size:18px;line-height:1.7">${esc(S.answer && S.answer.text)}</div>
    <div class="stack">${each(ansNotes, n => `<div class="row g12" style="padding:12px 0;border-top:1px solid var(--line);align-items:baseline" ${act('openNote', n.id)}><span style="font-size:12.5px;color:var(--ink-3);flex-shrink:0">${shortDate(n.date)}</span><span style="font-size:14.5px;color:var(--accent);line-height:1.5">${esc(n.summary)} →</span></div>`)}</div>
  </div>`)}
  ${x(q, `<div class="stack"><div style="font-size:13px;color:var(--ink-3);padding-bottom:4px">${isNL ? `관련 있을 만한 기록 ${results.length}편` : `‘${esc(q)}’ 포함 ${results.length}편`}</div>${each(results.slice(0, 80), n => noteRow(n, { showPath: true }))}</div>`)}
</section>`;
}

// ───────────────────────── 시작 ─────────────────────────
async function boot() {
  requestPersist();
  ai.onUsage = r => {
    const m = monthKey();
    const aiUsage = { ...S.aiUsage, [m]: (S.aiUsage[m] || 0) + 1 };
    set({ aiUsage, lastProvider: r.provider }); db.set('aiUsage', aiUsage);
  };
  let hadSession = false;
  sync.subscribe(() => {
    const has = !!sync.session();
    if (has && !hadSession && S.ready) {
      // 막 로그인됨(코드 입력, 메일 링크, 다른 탭) → 랜딩을 닫고 바로 동기화
      const wasLanding = showLanding();
      finishLanding();
      set({ loginStage: 'idle', code: '' });
      runSync();
      if (wasLanding) { go('write'); toast('로그인했어요. 기록을 맞추는 중이에요.'); }
    }
    hadSession = has;
    render();
  });
  try {
    const [notes, subBorn, lastExport, aiUsage, libView, landingDone, catsRec] = await Promise.all([db.allNotes(), db.get('subBorn'), db.get('lastExport'), db.get('aiUsage'), db.get('libView'), db.get('landingDone'), db.get('cats')]);
    Object.assign(S, { notes: notes || [], subBorn: subBorn || {}, lastExport: lastExport || null, aiUsage: aiUsage || {}, libView: libView || 'shelf', landingDone: !!landingDone });
    if (catsRec && Array.isArray(catsRec.list)) { setCats(catsRec.list); Object.assign(S, { catsAt: catsRec.updatedAt || null, catsDirty: !!catsRec.dirty }); }
  } catch (e) {
    Object.assign(S, { toast: '이 브라우저에서는 기록을 저장할 수 없어요(비공개 모드인지 확인해 주세요).' });
  }
  try { const d = localStorage.getItem('seojae-draft'); if (d) S.draft = d; } catch (e) { /* 무시 */ }
  await sync.init();
  hadSession = !!sync.session();
  if (hadSession && !S.landingDone) { S.landingDone = true; db.set('landingDone', true); }
  S.ready = true;
  history.replaceState(snapshot(), '');
  render();
  focusDraft();
  // 서재 보기 방식은 기억해 둔다
  let lastView = S.libView;
  setInterval(() => { if (S.libView !== lastView) { lastView = S.libView; db.set('libView', lastView); } }, 1500);
  if (sync.session()) runSync();
  setInterval(() => scheduleSync(0), 5 * 60 * 1000);
}
boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {}));
}
