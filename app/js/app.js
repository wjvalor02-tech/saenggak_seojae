import { morph, esc } from './morph.js';
import { getCats, setCats, nextHue, MAX_CATS, DEFAULT_CATS, catOf, catColor, todayS, pd, daysAgo, fmt, fmtPlain, shortDate, rel, todayLabel, uid, bookMeta, DOW } from './util.js';
import { db, deriveCats, normalizeImport, clean, requestPersist } from './store.js';
import { sync } from './sync.js';
import { ai, nlScore, titleOf } from './ai.js';
import { layoutNet } from './net.js';
import { makeXlsx, makeDocx, download } from './export.js';

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
  book: null, bookStatus: 'idle', bookDismissed: false,
  email: '', code: '', loginStage: 'idle', loginErr: null, loginBusy: false,
  lastExport: null, aiUsage: {}, toast: null, landingDone: false,
  // 분야 관리
  catsAt: null, catsDirty: false, catAdd: false, catEdit: null, editCatName: '', editCatEmoji: '',
  newCatName: '', newCatEmoji: '', catErr: null, delCat: null, delTarget: null,
  tagsDraft: [], newTagDraft: '',
  aiError: null, reclassBusy: false,
  weeklyBusy: null, openReport: null, blogOpen: null,
};
const root = document.getElementById('app');
let timer = null, bookTimer = null, bookToken = null, checkToken = null, lastKey = null, lastLen = 0, toastTimer = null, syncTimer = null;
let ta = null;

// kind가 있는 행(주간 돌아보기 등)은 글이 아니므로 목록에서 뺀다
const live = () => S.notes.filter(n => !n.deletedAt && !n.kind);
const sorted = () => live().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id));
const cats = () => deriveCats(live(), S.subBorn);
const findNote = id => S.notes.find(n => n.id === id && !n.deletedAt && !n.kind);
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
  const key = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  saveCats([...getCats(), { key, name, emoji, hue: nextHue() }]);
  // 새로 꽂은 책을 바로 골라 둔다
  set({ newCatName: '', newCatEmoji: '', catErr: null, catAdd: false, shelfKey: key });
  toast(`‘${name}’ 분야를 책장에 꽂았어요.`);
}
function startEditCat(key) {
  const c = getCats().find(x => x.key === key); if (!c) return;
  set({ catEdit: key, editCatName: c.name, editCatEmoji: c.emoji, delCat: null, catErr: null, catAdd: false, shelfKey: key });
}
function saveEditCat() {
  const key = S.catEdit; const c = getCats().find(x => x.key === key); if (!c) return;
  const name = S.editCatName.replace(/[<>&"'`]/g, '').trim();
  const emoji = S.editCatEmoji.replace(/[<>&"'`\s]/g, '').trim() || '📁';
  if (!name) { set({ catErr: '분야 이름을 적어 주세요.' }); return; }
  if (getCats().some(x => x.key !== key && x.name === name)) { set({ catErr: '같은 이름의 분야가 이미 있어요.' }); return; }
  // key는 그대로라서 글들은 따로 옮길 필요 없이 새 이름으로 보인다
  if (name !== c.name || emoji !== c.emoji) saveCats(getCats().map(x => x.key === key ? { ...x, name, emoji } : x));
  set({ catEdit: null, catErr: null });
  if (name !== c.name) toast(`‘${c.name}’ → ‘${name}’(으)로 바꿨어요.`);
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
  set({ delCat: null, delTarget: null, catEdit: null, shelfKey: S.shelfKey === key ? null : S.shelfKey });
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
  // 작성 완료를 누르지 않은 글(unconfirmed)은 아직 서버로 보내지 않는다
  getNotes: () => S.notes.filter(n => !n.unconfirmed),
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
  await reclassifyPending();
  maybeWeekly();
}

// AI가 실패해 휴리스틱으로 분류된 글을 나중에 다시 정리한다
let reclassifying = false;
// 분류 정확도를 높이는 힌트: ① 이미 쓰는 태그(같은 뜻이면 같은 표기를 다시 쓰게) ② 사용자가 직접 고친 분류(이 사람의 기준)
function classifyHints(excludeId) {
  const count = {};
  live().forEach(n => { if (!n.aiPending || n.userSorted) n.tags.forEach(t => { count[t] = (count[t] || 0) + 1; }); });
  const vocab = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([t]) => t).join(', ');
  const examples = live().filter(n => n.userSorted && n.id !== excludeId)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6)
    .map(n => `- "${n.body.replace(/\s+/g, ' ').slice(0, 140)}" → ${n.cat}(${catOf(n.cat).name})›${n.sub} ${n.tags.map(t => '#' + t).join(' ')}`).join('\n');
  return { vocab, examples };
}

async function reclassifyPending(limit = 5) {
  if (reclassifying || !ai.available()) return 0;
  const pending = live().filter(n => n.aiPending && !n.userSorted && !n.unconfirmed).slice(0, limit);
  if (!pending.length) return 0;
  reclassifying = true;
  let done = 0;
  try {
    for (const n of pending) {
      const r = await ai.classify(n.body, cats(), n.book, classifyHints(n.id));
      if (r.aiPending) break; // 아직 AI가 안 됨
      const cur = findNote(n.id);
      if (!cur || cur.userSorted) continue;
      addBorn(r.cat, r.sub);
      const { aiPending, ...rest } = cur;
      await writeNote({ ...rest, cat: r.cat, sub: r.sub, tags: r.tags, summary: r.summary, aiProvider: r.aiProvider });
      done++;
    }
  } finally { reclassifying = false; }
  return done;
}
// 서재 > 내 기록 관리의 'AI로 다시 정리' 버튼: 간단 분류된 글을 모두 다시 정리
async function reclassifyAll() {
  if (!ai.available()) { toast(ai.lastError || '로그인하고 온라인일 때 쓸 수 있어요.'); return; }
  set({ reclassBusy: true });
  let total = 0;
  for (let i = 0; i < 40; i++) { const d = await reclassifyPending(5); total += d; if (d < 5) break; }
  set({ reclassBusy: false });
  toast(total ? `글 ${total}편을 AI로 다시 정리했어요.` : (ai.lastError || '다시 정리할 글이 없어요.'));
}

// ───────────────────────── 주간 돌아보기 ─────────────────────────
// 매주 한 번(새 주에 처음 앱을 열 때) 지난주 기록을 AI가 읽고
// ① 생각 사이의 연결고리와 통찰 ② 블로그에 올릴 글감 하나를 만든다.
// 결과는 글과 같은 표에 kind:'weekly' 행으로 저장돼 다른 기기와도 동기화된다(주마다 id가 같아 중복되지 않음).
const ds = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, k) => { const d = pd(s); d.setDate(d.getDate() + k); return ds(d); };
const mondayOf = s => { const d = pd(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return ds(d); };
const weekLabel = mon => { const a = pd(mon), b = pd(addDays(mon, 6)); return `${a.getMonth() + 1}월 ${a.getDate()}일 – ${a.getMonth() === b.getMonth() ? '' : (b.getMonth() + 1) + '월 '}${b.getDate()}일`; };
const reports = () => S.notes.filter(n => n.kind === 'weekly' && !n.deletedAt).sort((a, b) => b.date.localeCompare(a.date));
const weekNotes = mon => live().filter(n => n.date >= mon && n.date <= addDays(mon, 6)).sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || ''));

async function makeWeekly(mon, { manual = false } = {}) {
  if (S.weeklyBusy) return;
  const notes = weekNotes(mon);
  if (!notes.length) { if (manual) toast('이 주에는 아직 기록이 없어요.'); return; }
  if (!ai.available()) { if (manual) toast(ai.lastError || '로그인하고 온라인일 때 만들 수 있어요.'); return; }
  set({ weeklyBusy: mon });
  try {
    // 지난 기록 제목도 조금 넘겨서 이번 주 생각이 예전 생각과 이어지는지 볼 수 있게 한다
    const past = live().filter(n => n.date < mon).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
    const r = await ai.weekly(notes.slice(-40), past, weekLabel(mon));
    if (!r) { if (manual) toast(ai.lastError || '돌아보기를 만들지 못했어요. 잠시 후 다시 해 주세요.'); return; }
    const final = todayS() > addDays(mon, 6); // 그 주가 끝난 뒤 만든 것인지
    const id = 'wk-' + mon;
    const prev = S.notes.find(n => n.id === id);
    await writeNote({
      id, kind: 'weekly', date: mon, weekEnd: addDays(mon, 6), final,
      // 예전 버전 앱이 이 행을 글로 착각해도 깨지지 않도록 기본 필드를 채워 둔다
      cat: 'daily', sub: '', tags: [], summary: '', body: '',
      noteIds: notes.map(n => n.id), noteCount: notes.length,
      overview: r.overview, connections: r.connections, blog: r.blog, provider: r.provider,
      generatedAt: new Date().toISOString(), seen: S.screen === 'timeline',
      createdAt: (prev && prev.createdAt) || new Date().toISOString(),
    });
    set({ openReport: id });
    if (!manual && S.screen !== 'timeline') toast(`${weekLabel(mon)} 돌아보기가 도착했어요. 흐름 탭에서 볼 수 있어요.`);
  } finally { set({ weeklyBusy: null }); }
}

// 새 주가 되면 지난주 돌아보기를 자동으로 만든다(동기화가 끝난 뒤 → 다른 기기가 이미 만들었으면 그걸 쓴다)
let weeklyChecked = false;
async function maybeWeekly() {
  if (weeklyChecked || !ai.available()) return;
  const lastMon = addDays(mondayOf(todayS()), -7);
  const existing = S.notes.find(n => n.id === 'wk-' + lastMon && !n.deletedAt);
  if (existing && existing.final) { weeklyChecked = true; return; }
  if (!weekNotes(lastMon).length) { weeklyChecked = true; return; }
  // 실패해도 계속 다시 부르지 않도록 6시간에 한 번만 시도
  const tried = await db.get('weeklyTried').catch(() => null);
  if (tried && tried.mon === lastMon && Date.now() - tried.at < 6 * 3600e3) return;
  weeklyChecked = true;
  await db.set('weeklyTried', { mon: lastMon, at: Date.now() });
  await makeWeekly(lastMon);
}

// 처음엔 가장 최근 돌아보기를 펼쳐 둔다. 'none'이면 모두 접힘.
const openReportId = () => (S.openReport === null ? (reports()[0] || {}).id : S.openReport);

function blogMarkdown(b) {
  return [`# ${b.title}`, '', b.hook, '', b.draft, '', b.tags.length ? b.tags.map(t => '#' + t).join(' ') : ''].join('\n').trim() + '\n';
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    // 권한이 없거나 오래된 브라우저: 임시 입력칸으로 복사
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (x2) { /* 무시 */ }
    t.remove(); return ok;
  }
}

// ───────────────────────── 화면 이동 ─────────────────────────
const SCREEN_LABEL = { write: '기록', library: '서재', timeline: '흐름', search: '검색', category: '분야', detail: '이전 글' };
function snapshot() { return { screen: S.screen, tab: S.tab, noteId: S.noteId, catKey: S.catKey, subFilter: S.subFilter, from: S.from, depth: S.depth }; }
function go(screen) {
  set({ screen, tab: screen, depth: 0, from: null, noteId: null, bodyEditing: false, detailEditing: false, netSel: screen === 'timeline' ? S.netSel : null });
  history.replaceState(snapshot(), '');
  window.scrollTo(0, 0);
  if (screen === 'write') focusDraft();
  // 흐름 탭을 열면 새 돌아보기를 '읽음'으로(탭의 점이 사라짐). 가장 최근 것은 펼쳐 둔다.
  if (screen === 'timeline') {
    const unseen = reports().filter(r => !r.seen);
    if (unseen.length) { set({ openReport: unseen[0].id }); unseen.forEach(r => patch(r.id, { seen: true })); }
  }
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
  const draftNote = { id, date: writeDate(), cat: 'daily', sub: '생각', tags: [], summary: titleOf(text), body: text, aiPending: true, unconfirmed: true, createdAt: now, ...(book ? { book } : {}), ...(checks ? { checks } : {}) };
  // 고른 날짜는 이 글에만 쓰고 다음 글은 다시 오늘로(모르고 지난 날짜로 저장되는 것을 막음)
  set({ phase: 'classifying', draft: '', writeDate: null, editing: false, book: null, bookStatus: 'idle', bookDismissed: false, checks: null, checkStatus: 'idle', resId: id, resNote: '' });
  await writeNote(draftNote);

  const before = cats();
  const aiP = ai.classify(text, before, book, classifyHints(id));
  // 분류 결과를 글에 적용. late=true(AI가 늦게 도착)일 때 사용자가 그새 분류·태그를 고쳤으면 건드리지 않는다
  const apply = async (r, late) => {
    const cur = S.notes.find(n => n.id === id);
    if (!cur || cur.deletedAt || (late && cur.userSorted)) return null;
    // '새 갈래'인지는 방금 쓴 이 글을 뺀 나머지 글들 기준으로 판단한다
    const cs = deriveCats(live().filter(n => n.id !== id), S.subBorn);
    const c = cs.find(x => x.key === r.cat) || cs.find(x => x.key === 'daily') || cs[0];
    const isNew = !c.subs.some(s => s.name === r.sub);
    addBorn(c.key, r.sub);
    const { aiPending: _p, ...base } = cur;
    await writeNote({ ...base, cat: c.key, sub: r.sub, tags: r.tags, summary: r.summary, ...(r.aiPending ? { aiPending: true } : {}), ...(r.aiProvider ? { aiProvider: r.aiProvider } : {}) });
    return isNew;
  };
  const failNote = () => (sync.configured() && sync.session() ? `간단히 분류했어요. ${ai.lastError || 'AI 연결이 잠시 어려워요.'} 연결되면 다시 정리할게요.` : '');

  // 시트는 8초까지만 기다린다. AI가 그 안에 오면 바로 보여 주고,
  const quick = await Promise.race([aiP, new Promise(res => setTimeout(() => res(null), 8000))]);
  if (quick) {
    const isNew = await apply(quick, false);
    // AI가 실패했으면 이유를 함께 알린다(예전엔 조용히 간단 분류만 해서 원인을 알 수 없었다)
    set({ phase: 'done', resNew: !!isNew, resNote: quick.aiPending ? failNote() : '' });
    // 자동으로 닫지 않는다: 사용자가 '작성 완료'를 눌러야 확정
    return;
  }
  // 늦으면 간단 분류로 먼저 보여 주고, AI 결과가 도착하면 저절로 바꾼다(다음 글을 바로 쓸 수 있게)
  const isNew = await apply(ai.guess(text, before, book), false);
  set({ phase: 'done', resNew: !!isNew, resNote: 'AI가 아직 정리하는 중이에요. 끝나면 분류와 태그가 저절로 바뀌어요.' });

  const r = await aiP;
  const here = () => S.resId === id && S.phase === 'done';
  if (r.aiPending) { if (here()) set({ resNote: failNote() }); return; }
  const changed = await apply(r, true);
  if (changed !== null && here()) set({ resNew: changed, resNote: 'AI가 정리를 마쳤어요.' });
}
// (예전엔 4초 뒤 시트가 저절로 닫혀 확인하기 전에 저장된 것처럼 보였다 → 이제 '작성 완료'를 눌러야 닫힌다)

// '작성 완료': 확정하고 동기화 대상으로 올린다
async function confirmNote() {
  const n = S.notes.find(x => x.id === S.resId);
  if (n && n.unconfirmed) { const { unconfirmed: _u, ...rest } = n; await writeNote(rest); }
  dismiss();
  showNextUnconfirmed();
}
// '다시 고치기': 확정 전이라 서버에 간 적이 없으니 글을 지우고, 쓴 내용을 입력칸으로 되돌린다
async function reviseNote() {
  const n = S.notes.find(x => x.id === S.resId);
  dismiss();
  if (!n) return;
  set({ notes: S.notes.filter(x => x.id !== n.id), resId: null });
  try { await db.delNote(n.id); } catch (e) { /* 무시 */ }
  set({
    draft: n.body, writeDate: n.date !== todayS() ? n.date : null,
    ...(n.book ? { book: { ...n.book, key: 'restored' }, bookStatus: 'found', bookDismissed: false } : {}),
    ...(n.checks && n.checks.length ? { checks: n.checks, checkStatus: 'done' } : {}),
  });
  try { localStorage.setItem('seojae-draft', n.body); } catch (e) { /* 무시 */ }
  focusDraft();
}
// 작성 완료를 누르기 전에 앱이 닫혔던 글이 있으면 다시 보여 준다(기록은 기기에 안전하게 남아 있음)
function showNextUnconfirmed() {
  const u = S.notes.filter(n => n.unconfirmed && !n.deletedAt).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
  if (u) set({ resId: u.id, phase: 'done', editing: false, resNew: false, resNote: '아직 작성 완료를 누르지 않은 글이에요. 분류를 확인하고 완료해 주세요.' });
}
function dismiss() { clearTimeout(timer); set({ phase: 'idle', editing: false, newTag: '', newSub: '' }); if (S.screen === 'write') focusDraft(); }

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
// 태그: '#'·띄어쓰기를 빼고, 20자 이내, 중복 없이, 최대 8개
const cleanTag = t => String(t).replace(/^#+/, '').replace(/[\s,#<>&"'`]/g, '').slice(0, 20);
function addTagWord(w) {
  const t = cleanTag(w);
  if (!t || S.tagsDraft.includes(t) || S.tagsDraft.length >= 8) return;
  S.tagsDraft = [...S.tagsDraft, t];
}
function addTagDraft() { addTagWord(S.newTagDraft); set({ newTagDraft: '', tagsDraft: S.tagsDraft }); }

function startBodyEdit() {
  const n = findNote(S.noteId); if (!n) return;
  set({ bodyEditing: true, bodyDraft: n.body, bodyDate: n.date, tagsDraft: [...n.tags], newTagDraft: '', detailEditing: false });
}
function saveBody(id) {
  const body = S.bodyDraft.trim(); if (!body) return;
  const n = findNote(id); if (!n) return;
  if (S.newTagDraft.trim()) addTagWord(S.newTagDraft); // 입력칸에 쓰다 만 태그도 함께 저장
  const tags = [...S.tagsDraft];
  const tagsChanged = tags.join('\u0001') !== n.tags.join('\u0001');
  writeNote({
    ...n, body, tags,
    // 작성 날짜를 바꿨으면 함께 저장(미래 날짜는 막음)
    date: S.bodyDate && S.bodyDate <= todayS() ? S.bodyDate : n.date,
    // 목록 제목은 AI 요약 대신 글의 첫 문장(본문이 바뀌면 같이 바뀜)
    summary: titleOf(body),
    ...(body !== n.body || tagsChanged ? { edited: todayS() } : {}),
    // 직접 고친 태그는 나중에 AI가 다시 정리할 때 덮어쓰지 않는다
    ...(tagsChanged ? { userSorted: true } : {}),
  });
  set({ bodyEditing: false, newTagDraft: '' });
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
  const text = hits.length ? `${fmtPlain(hits[0].date)}에 “${titleOf(hits[0].body)}”라고 남겼어요.${hits[1] ? ` 비슷한 생각은 ${fmtPlain(hits[1].date)}에도 있었어요.` : ''}` : '관련된 기록을 찾지 못했어요.';
  set({ aiLoading: false, answer: { text, ids: hits.map(n => n.id) } });
}

// ───────────────────────── 백업 ─────────────────────────
function exportData() {
  const payload = { app: '생각서재', version: 1, saved: new Date().toISOString(), cats: cats(), notes: sorted().map(clean), subBorn: S.subBorn, weekly: reports().map(clean) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `생각서재-백업-${todayS()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  const at = new Date().toISOString(); set({ lastExport: at }); db.set('lastExport', at);
}
// ───────── 엑셀·워드 내보내기 (읽기·인쇄용, 앱으로 다시 불러올 수는 없음) ─────────
const DOW_KO = '일월화수목금토';
const tagLine = n => n.tags.map(t => '#' + t).join(' ');
const bookLine = b => b ? `『${b.title}』${bookMeta(b) ? ' ' + bookMeta(b) : ''}` : '';
const plainDraft = md => String(md || '').split('\n').map(l => l.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '• ').replace(/\*\*/g, '')).join('\n');

function exportXlsx() {
  const notes = sorted().reverse(); // 과거 → 최근 순(아래로 갈수록 최근)
  const noteRows = notes.map(n => {
    const c = catOf(n.cat);
    return [n.date, DOW_KO[pd(n.date).getDay()], c.name, n.sub, tagLine(n), titleOf(n.body), n.body, bookLine(n.book), n.edited || '', n.aiPending ? '간단 분류' : 'AI'];
  });
  const weekRows = reports().reverse().map(r => [
    weekLabel(r.date) + (r.final ? '' : ' (진행 중)'),
    r.overview || '',
    (r.connections || []).map(c => `[${c.title}] ${c.insight}`).join('\n\n'),
    r.blog ? r.blog.title : '',
    r.blog ? [r.blog.hook, '', plainDraft(r.blog.draft)].join('\n').trim() : '',
    r.blog ? r.blog.tags.map(t => '#' + t).join(' ') : '',
  ]);
  const cs = cats().filter(c => !c.virtual);
  const catRows = [];
  cs.forEach(c => {
    const ns = notes.filter(n => n.cat === c.key);
    if (!c.subs.length) catRows.push([`${c.emoji} ${c.name}`, '', ns.length]);
    c.subs.forEach(sb => catRows.push([`${c.emoji} ${c.name}`, sb.name, ns.filter(n => n.sub === sb.name).length]));
  });
  const blob = makeXlsx([
    { name: '기록', rows: noteRows, cols: [{ title: '날짜', width: 12 }, { title: '요일', width: 6 }, { title: '분야', width: 10 }, { title: '갈래', width: 14 }, { title: '태그', width: 24 }, { title: '제목', width: 36 }, { title: '본문', width: 80 }, { title: '책', width: 30 }, { title: '수정한 날', width: 12 }, { title: '분류', width: 10 }] },
    { name: '주간 돌아보기', rows: weekRows, cols: [{ title: '주', width: 20 }, { title: '이번 주 흐름', width: 50 }, { title: '생각의 연결고리', width: 60 }, { title: '블로그 글감 제목', width: 30 }, { title: '블로그 초안', width: 80 }, { title: '글감 태그', width: 24 }] },
    { name: '분야와 갈래', rows: catRows, cols: [{ title: '분야', width: 16 }, { title: '갈래', width: 18 }, { title: '글 수', width: 8 }] },
  ]);
  download(blob, `생각서재-기록-${todayS()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  toast(`글 ${notes.length}편을 엑셀로 내보냈어요.`);
}

function exportDocx() {
  const notes = sorted().reverse(); // 과거 → 최근 순(아래로 갈수록 최근)
  const blocks = [
    { type: 'title', text: '생각서재 기록' },
    { type: 'meta', text: `${fmtPlain(todayS())} 내보냄 · 글 ${notes.length}편` },
  ];
  let month = '';
  for (const n of notes) {
    const m = n.date.slice(0, 7);
    if (m !== month) { month = m; blocks.push({ type: 'h1', text: `${m.slice(0, 4)}년 ${Number(m.slice(5))}월` }); }
    const c = catOf(n.cat);
    blocks.push({ type: 'h2', text: titleOf(n.body) });
    blocks.push({ type: 'meta', text: [fmt(n.date), `${c.emoji} ${c.name} › ${n.sub}`, tagLine(n)].filter(Boolean).join(' · ') });
    if (n.book) blocks.push({ type: 'meta', text: '📖 ' + bookLine(n.book) });
    // 짧은 글은 제목이 곧 본문이라 본문을 다시 쓰지 않는다
    if (titleOf(n.body) !== n.body.replace(/\s+/g, ' ').trim()) {
      n.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).forEach(p => blocks.push({ type: 'p', text: p }));
    }
  }
  const rs = reports().reverse();
  if (rs.length) {
    blocks.push({ type: 'h1', text: '주간 돌아보기' });
    for (const r of rs) {
      blocks.push({ type: 'h2', text: weekLabel(r.date) + (r.final ? '' : ' (진행 중)') });
      if (r.overview) blocks.push({ type: 'quote', text: r.overview });
      (r.connections || []).forEach(c => blocks.push({ type: 'bullet', text: `${c.title} — ${c.insight}` }));
      if (r.blog) {
        blocks.push({ type: 'meta', text: '✍️ 블로그 글감' });
        blocks.push({ type: 'h2', text: r.blog.title });
        if (r.blog.hook) blocks.push({ type: 'quote', text: r.blog.hook });
        plainDraft(r.blog.draft).split(/\n{2,}/).map(p => p.trim()).filter(Boolean).forEach(p => blocks.push({ type: 'p', text: p }));
        if (r.blog.tags.length) blocks.push({ type: 'meta', text: r.blog.tags.map(t => '#' + t).join(' ') });
      }
    }
  }
  download(makeDocx(blocks), `생각서재-기록-${todayS()}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  toast(`글 ${notes.length}편을 워드로 내보냈어요.`);
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
  go: a => go(a), back, save, dismiss, confirmNote, reviseNote, runCheck, exportData, resetAll, sendLink, verifyCode, ask,
  openNote: a => { if (S.phase === 'done') confirmNote(); openNote(a); }, openCat: (a, el) => openCat(a, el.dataset.sub || null),
  importClick: () => document.getElementById('file-in').click(),
  dismissBook: () => { bookToken = null; set({ bookDismissed: true }); },
  // 작성 날짜: 날짜 칸을 누르면 달력을 연다(지원하는 브라우저). 휴대폰은 기본 날짜 선택기가 뜬다.
  openDatePicker: (a, el) => { try { el.showPicker && el.showPicker(); } catch (e) { /* 일부 브라우저는 직접 열기를 막음 → 기본 동작 */ } },
  dateToday: () => { set({ writeDate: null }); focusDraft(); },
  closeCheck: () => { checkToken = null; set({ checkStatus: 'idle', checks: null }); },
  removeCheck: a => set({ checks: S.checks.filter((_, k) => k !== +a) }),
  toggleCat: () => set({ editing: !S.editing, newSub: '' }),
  pickCat: (a, el) => { const id = el.dataset.id; const n = findNote(id); if (!n || n.cat === a) return; const c = cats().find(x => x.key === a); setCatSub(id, a, c.subs[0] ? c.subs[0].name : '일반'); },
  pickSub: (a, el) => { const n = findNote(el.dataset.id); if (n) setCatSub(n.id, n.cat, a); },
  addSub: a => addSub(a),
  removeTag: (a, el) => { const n = findNote(el.dataset.id); if (n) patch(n.id, { tags: n.tags.filter(t => t !== a), userSorted: true }); },
  libView: a => set({ libView: a }),
  shelf: a => set({ shelfKey: a, catAdd: false, catEdit: S.catEdit === a ? a : null, delCat: null, catErr: null }),
  subFilter: a => set({ subFilter: a || null }),
  startBodyEdit,
  cancelBodyEdit: () => set({ bodyEditing: false }),
  saveBody: () => saveBody(S.noteId),
  deleteNote: () => deleteNote(S.noteId),
  toggleDetEdit: () => set({ detailEditing: !S.detailEditing, newSub: '' }),
  confirmCheck: a => { const n = findNote(S.noteId); if (n) patch(n.id, { checks: (n.checks || []).filter((_, k) => k !== +a) }); },
  netSel: a => set({ netSel: S.netSel === a ? null : a }),
  example: a => { set({ query: a, answer: null }); if (!a.startsWith('#')) ask(); },
  syncNow: () => runSync(),
  exportXlsx: () => exportXlsx(), exportDocx: () => exportDocx(),
  reclassifyAll: () => reclassifyAll(),
  // 주간 돌아보기
  weeklyNow: () => makeWeekly(mondayOf(todayS()), { manual: true }),
  weeklyRedo: a => { if (confirm('이 주의 돌아보기를 새로 만들까요? 지금 내용은 바뀌어요.')) makeWeekly(a, { manual: true }); },
  openReport: a => set({ openReport: openReportId() === a ? 'none' : a, blogOpen: null }),
  blogOpen: a => set({ blogOpen: S.blogOpen === a ? null : a }),
  copyBlog: async a => { const r = S.notes.find(n => n.id === a); if (r && r.blog) toast(await copyText(blogMarkdown(r.blog)) ? '글감을 복사했어요. 블로그 편집기에 붙여 넣으세요.' : '복사하지 못했어요. 본문을 길게 눌러 직접 복사해 주세요.'); },
  signOut: async () => { if (confirm('로그아웃할까요? 이 기기의 기록은 그대로 남아요.')) { await sync.signOut(); toast('로그아웃했어요.'); } },
  loginReset: () => set({ loginStage: 'idle', code: '', loginErr: null }),
  skipLanding: () => { finishLanding(); focusDraft(); },
  // 책장에서 바로 분야 추가·수정·삭제
  openCatAdd: () => set({ catAdd: true, catEdit: null, delCat: null, catErr: null }),
  closeCatAdd: () => set({ catAdd: false, catErr: null, newCatName: '', newCatEmoji: '' }),
  addCat, startEditCat: a => startEditCat(a), saveEditCat,
  cancelEditCat: () => set({ catEdit: null, delCat: null, catErr: null }),
  askDeleteCat: a => askDeleteCat(a), deleteCat, resetCats,
  // 책등의 🗑️: 수정 칸을 열면서 바로 삭제 확인을 띄운다
  quickDeleteCat: a => { startEditCat(a); askDeleteCat(a); },
  cancelDeleteCat: () => set({ delCat: null, delTarget: null }),
  delTarget: a => set({ delTarget: a }),
  // 글 수정 화면의 태그
  removeTagDraft: a => set({ tagsDraft: S.tagsDraft.filter(t => t !== a) }),
  addTagDraft: () => addTagDraft(),
};
const IN = {
  writeDate: v => set({ writeDate: v && v <= todayS() ? v : null }),
  bodyDate: v => set({ bodyDate: v && v <= todayS() ? v : S.bodyDate }),
  newCatName: v => set({ newCatName: v, catErr: null }), newCatEmoji: v => set({ newCatEmoji: v, catErr: null }),
  editCatName: v => set({ editCatName: v, catErr: null }), editCatEmoji: v => set({ editCatEmoji: v, catErr: null }),
  newTagDraft: v => {
    // 쉼표나 띄어쓰기를 치면 그때까지 쓴 말을 태그로 만든다
    if (/[,\s]/.test(v)) { v.split(/[,\s]+/).slice(0, -1).forEach(addTagWord); set({ newTagDraft: v.split(/[,\s]+/).pop() }); }
    else set({ newTagDraft: v });
  },
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
  editCatName: e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveEditCat(); } },
  newTagDraft: e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTagDraft(); }
    // 빈 칸에서 지우기를 누르면 마지막 태그를 지운다
    else if (e.key === 'Backspace' && !S.newTagDraft && S.tagsDraft.length) set({ tagsDraft: S.tagsDraft.slice(0, -1) });
  },
};
root.addEventListener('click', e => {
  if (e.target.closest('.sheet')) clearTimeout(timer); // 시트를 만지면 자동 닫힘 멈춤
  const el = e.target.closest('[data-act]');
  if (!el || !root.contains(el)) return;
  const f = A[el.dataset.act];
  // 입력칸(날짜 등)은 기본 동작(키보드·날짜 선택기)을 막지 않는다
  if (f) { if (el.tagName !== 'INPUT') e.preventDefault(); f(el.dataset.arg ?? '', el, e); }
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
// HTML은 <textarea> 바로 뒤의 줄바꿈 하나를 버린다. 그래서 글이 줄바꿈으로 시작하면(맨 앞에서 Enter → 위에 줄 추가)
// 다시 그릴 때 그 줄이 사라지고 커서가 끝으로 튀었다. 줄바꿈 하나를 먼저 넣어 두면 원래 내용이 그대로 남는다.
const taText = s => '\n' + esc(s);
// 글을 쓸 날짜(기본: 오늘). 미래 날짜는 고를 수 없다.
const writeDate = () => (S.writeDate && S.writeDate <= todayS() ? S.writeDate : todayS());
const fmtLong = s => fmt(s).replace(/ \((.)\)/, ' $1요일');
const act = (name, arg = '', extra = '') => `data-act="${name}" data-arg="${esc(arg)}"${extra}`;

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
  const newReport = reports().some(r => !r.seen);

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
    <nav>${each(tabs, ([k, l]) => `<button class="nav-item${navActive === k ? ' on' : ''}" ${act('go', k)}>${l}${x(k === 'timeline' && newReport, '<span class="new-dot" aria-label="새 돌아보기"></span>')}</button>`)}</nav>
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
  ${x(showNav, `<nav class="tabbar">${each(tabs, ([k, l]) => `<button class="${navActive === k ? 'on' : ''}" ${act('go', k)}>${l}${x(k === 'timeline' && newReport, '<span class="new-dot" aria-label="새 돌아보기"></span>')}<i></i></button>`)}</nav>`)}
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
  const wd = writeDate();
  const past = wd !== todayS();
  // 글 입력칸 위쪽 요소들은 항상 같은 상자(.draft-top) 안에 둔다.
  // 입력칸 앞에 요소가 생겼다 사라지면 화면 갱신 때 입력칸이 새로 만들어져 커서·포커스를 잃기 때문.
  return `<section class="stack g20">
  <div class="draft-top stack g20">
  <div class="date-row${typing ? ' typing' : ''}">
    <label class="date-pick${past ? ' past' : ''}">
      <span>${fmtLong(wd)}</span><span class="caret" aria-hidden="true">▾</span>
      <input type="date" class="date-input" aria-label="작성 날짜" max="${todayS()}" value="${wd}" data-in="writeDate" ${act('openDatePicker')}>
    </label>
    ${x(past, `<span class="date-note">지난 날짜로 기록해요</span><button class="link-accent" ${act('dateToday')}>오늘로</button>`)}
  </div>
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
  </div>
  <textarea class="draft" data-in="draft" data-kd="draft" placeholder="떠오르는 생각을 그대로 적어보세요." aria-label="생각 기록">${taText(S.draft)}</textarea>
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
      <span class="hint">${typing ? `${draftLen}자${wide ? ` · ${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}↵ 저장` : ''}` : '제목도 분류도 필요 없어요. 쓰기만 하세요.'}</span>
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
    ${each(notes.slice(0, 3), n => `<div class="recent-row" ${act('openNote', n.id)}><span class="when">${rel(n.date)}</span><span class="what">${esc(titleOf(n.body))}</span></div>`)}
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
      return `<div style="font-size:13px;color:var(--ink-2)">이렇게 정리했어요 · 확인 후 작성 완료를 눌러 주세요</div>
      <div class="stack g12">
        <div class="cat-row" ${act('toggleCat')}><span class="path">${c.emoji} ${c.name} › ${esc(n.sub)}</span><span class="link-accent">${S.editing ? '닫기' : '바꾸기'}</span></div>
        ${x(S.editing, vEditor(n, cs, false))}
        ${x(S.resNew, `<div class="row g6" style="font-size:13px;color:var(--accent)"><span class="dot"></span>새 갈래가 자랐어요</div>`)}
        <div class="row g6 wrap">
          ${each(n.tags, t => `<button class="tag-chip" ${act('removeTag', t, idA)}>#${esc(t)} <span>×</span></button>`)}
          <input class="dashed" placeholder="+ 추가" value="${esc(S.newTag)}" data-in="newTag" data-kd="newTag">
        </div>
        ${n.book ? `<div style="font-size:14px;line-height:1.5">📖 『${esc(n.book.title)}』 <span style="color:var(--ink-2)">${esc(bookMeta(n.book))}</span></div>` : ''}
        ${x(n.checks && n.checks.length, `<div style="font-size:13px;color:var(--caution)">확인할 내용 ${(n.checks || []).length}개를 글에 함께 남겼어요.</div>`)}
        ${x(S.resNote, `<div style="font-size:13px;color:var(--ink-3)">${esc(S.resNote)}</div>`)}
      </div>
      ${x(rel3.length, `<div class="row g8" style="font-size:13px;color:var(--accent);border-top:1px solid var(--line);padding-top:14px;line-height:1.5" ${act('openNote', rel3[0] ? rel3[0].n.id : '')}><span class="dot"></span>관련된 생각 ${rel3.length}개 — 「${esc(rel3[0] ? titleOf(rel3[0].n.body) : '')}」${rel3.length > 1 ? ' 외' : ''}</div>`)}
      <div class="row g8"><button class="btn-o" style="flex:0 0 auto;min-height:50px;padding:12px 18px" ${act('reviseNote')}>다시 고치기</button><button class="btn" style="flex:1;padding:15px;min-height:50px" ${act('confirmNote')}>작성 완료</button></div>`;
    })();
  return `<div class="sheet-wrap"><div class="sheet-bg"></div><div class="sheet" role="dialog" aria-label="저장 결과"><div class="handle"></div>${inner}</div></div>`;
}

function vLibrary(cs) {
  const all = sorted();
  const lib = cs.map(c => {
    const ns = all.filter(n => n.cat === c.key);
    return { ...c, ns, count: ns.length, last: ns[0] ? rel(ns[0].date) : '—', lastDate: ns[0] ? ns[0].date + (ns[0].createdAt || '') : '', latest: ns[0] ? titleOf(ns[0].body) : '', latestId: ns[0] && ns[0].id,
      subs: c.subs.map(sb => ({ ...sb, count: ns.filter(n => n.sub === sb.name).length, isNew: daysAgo(sb.born) <= 14 })) };
  }).sort((a, b) => b.lastDate.localeCompare(a.lastDate));
  const maxC = Math.max(1, ...lib.map(c => c.count));
  const openKey = S.shelfKey || lib[0].key;
  const oc = lib.find(c => c.key === openKey) || lib[0];
  const subCount = cs.reduce((a, c) => a + c.subs.length, 0);
  const subtitle = all.length ? `생각 ${all.length}편이 ${cs.length}개 분야, ${subCount}개 갈래로 저절로 정리되었어요.` : '아직 비어 있어요. 기록을 남기면 분야 아래 갈래가 저절로 자라요.';
  const subA = (c, sb) => `${act('openCat', c.key)} data-sub="${esc(sb.name)}"`;

  let body = '';
  if (S.libView === 'shelf') {
    const canAdd = getCats().length < MAX_CATS;
    const editing = !S.catAdd && S.catEdit === oc.key && !oc.virtual;
    const toc = `
      ${each(oc.subs, (sb, i) => `<div class="toc-row" ${subA(oc, sb)}><span class="row g10"><span style="color:var(--ink-3);width:28px">${i + 1}장</span>${esc(sb.name)}${x(sb.isNew, '<span class="new-badge">새 갈래</span>')}</span><span style="color:var(--ink-3);font-size:13px">${sb.count}</span></div>`)}
      ${x(!oc.subs.length, `<div style="border-top:1px solid var(--line);padding:16px 0;font-size:14.5px;color:var(--ink-3)">아직 갈래가 없어요. 이 분야의 글이 쌓이면 목차가 생겨요.</div>`)}
      ${x(oc.latest, `<div class="stack g6" style="border-top:1px solid var(--line);padding-top:16px" ${act('openNote', oc.latestId)}><span style="font-size:12px;color:var(--ink-3);letter-spacing:0.06em">가장 최근 페이지 · ${oc.last}</span><span class="serif" style="font-size:16.5px;line-height:1.6">“${esc(oc.latest)}”</span></div>`)}`;
    const header = `<div class="row between g8" style="align-items:baseline;padding-bottom:10px">
        <span class="serif" style="font-size:21px;font-weight:700">${oc.emoji} ${oc.name}의 목차</span>
        <span class="row g12" style="flex-shrink:0">
          <span style="font-size:13px;color:var(--accent);padding:6px 0" ${act('openCat', oc.key)}>전체 ${oc.count}편 →</span>
        </span>
      </div>`;
    const panel = S.catAdd ? vCatAddPanel() : editing ? vCatEditPanel(oc) + toc : header + toc;
    body = `<div class="stack g28">
    <div class="stack g8"><div class="shelf">
      ${each(lib, c => { const on = !S.catAdd && c.key === openKey; return `<div class="spine${on ? ' on' : ''}" role="button" tabindex="0" style="width:${38 + Math.round(c.count / maxC * 20)}px;height:${130 + Math.round(c.count / maxC * 120)}px;background:${catColor(c.hue)}" ${act('shelf', c.key)} aria-label="${c.name} ${c.count}편">${x(on && !c.virtual, `<div class="spine-tools"><button class="spine-tool" aria-label="${c.name} 분야 이름 바꾸기" title="이름 바꾸기" ${act('startEditCat', c.key)}>✏️</button><button class="spine-tool" aria-label="${c.name} 분야 삭제" title="삭제" ${act('quickDeleteCat', c.key)} ${getCats().length <= 1 ? 'disabled' : ''}>🗑️</button></div>`)}<span class="nm">${c.name}</span><span class="ct">${c.count}</span></div>`; })}
      ${x(canAdd, `<button class="spine add${S.catAdd ? ' on' : ''}" ${act('openCatAdd')} aria-label="새 분야 추가"><span class="plus">+</span><span class="nm">분야 추가</span></button>`)}
    </div><div class="shelf-board"></div>
    <div class="shelf-hint">책을 누르면 목차가 열리고, 책 위의 ✏️로 이름을, 🗑️로 분야를 지울 수 있어요. ＋ 책으로 새 분야를 꽂아요.</div></div>
    <div class="stack">${panel}</div></div>`;
  }
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
  ${vManage()}
</section>`;
}

const catSqlHint = () => x(sync.session() && sync.catsSupported() === false, `<div class="notice caution" style="font-size:12.5px">분야 목록은 아직 이 기기에만 저장돼요. 다른 기기와 맞추려면 Supabase에서 <b>supabase/add-categories.sql</b>을 한 번 실행해 주세요.</div>`);
const catErrLine = () => x(S.catErr, `<div style="font-size:13px;color:var(--warn-ink)">${esc(S.catErr)}</div>`);

// 책장의 ＋ 책을 눌렀을 때: 새 분야 꽂기
function vCatAddPanel() {
  return `<div class="cat-panel">
    <div class="serif" style="font-size:19px;font-weight:700">새 분야를 책장에 꽂아요</div>
    <div style="font-size:13px;color:var(--ink-2);line-height:1.6">저장할 때 AI가 책장에 있는 분야 중에서 골라요. 갈래(세부 분류)는 글에 맞춰 저절로 자라요.</div>
    <div class="row g8 wrap">
      <input class="field" style="flex:0 0 72px;text-align:center" maxlength="4" placeholder="📁" aria-label="분야 이모지" value="${esc(S.newCatEmoji)}" data-in="newCatEmoji">
      <input class="field" style="min-width:150px" maxlength="10" placeholder="분야 이름 (예: 신앙, 여행)" aria-label="새 분야 이름" value="${esc(S.newCatName)}" data-in="newCatName" data-kd="newCatName">
    </div>
    ${catErrLine()}
    <div class="row between g8 wrap">
      <button class="btn-t" style="font-size:12.5px;color:var(--ink-3)" ${act('resetCats')}>기본 분야 6개로 되돌리기</button>
      <div class="row g8">
        <button class="btn-o" style="min-height:44px;padding:10px 18px" ${act('closeCatAdd')}>취소</button>
        <button class="btn sm" ${act('addCat')} ${S.newCatName.trim() ? '' : 'disabled'}>꽂기</button>
      </div>
    </div>
    ${catSqlHint()}
  </div>`;
}

// 고른 책의 '수정': 이름·이모지 바꾸기, 분야 삭제(글은 다른 분야로 옮김)
function vCatEditPanel(oc) {
  const list = getCats();
  const n = live().filter(x2 => x2.cat === oc.key).length;
  const del = S.delCat === oc.key ? `<div class="cat-del">
      <div style="font-size:14.5px;font-weight:600">${oc.emoji} ${oc.name} 분야를 책장에서 뺄까요?</div>
      ${n ? `<div style="font-size:13px;color:var(--ink-2);line-height:1.55">이 분야의 글 ${n}편을 옮길 분야를 골라 주세요. 갈래와 태그는 그대로 따라가요.</div>
      <div class="row g6 wrap">${each(list.filter(o => o.key !== oc.key), o => `<button class="chip${S.delTarget === o.key ? ' on' : ''}" ${act('delTarget', o.key)}>${o.emoji} ${o.name}</button>`)}</div>`
      : `<div style="font-size:13px;color:var(--ink-2)">이 분야에는 글이 없어요.</div>`}
      <div class="row g8" style="justify-content:flex-end">
        <button class="btn-o" style="min-height:40px;padding:8px 16px" ${act('cancelDeleteCat')}>그만두기</button>
        <button class="btn xs" style="background:var(--warn)" ${act('deleteCat')}>${n ? '옮기고 삭제' : '삭제'}</button>
      </div>
    </div>` : '';
  return `<div class="cat-panel" style="margin-bottom:14px">
    <div class="row between" style="align-items:baseline"><div class="serif" style="font-size:19px;font-weight:700">분야 수정</div><span style="font-size:13px;color:var(--ink-3)">${n}편</span></div>
    <div class="row g8 wrap">
      <input class="field" style="flex:0 0 72px;text-align:center" maxlength="4" aria-label="분야 이모지" value="${esc(S.editCatEmoji)}" data-in="editCatEmoji">
      <input class="field" style="min-width:150px" maxlength="10" aria-label="분야 이름" value="${esc(S.editCatName)}" data-in="editCatName" data-kd="editCatName">
    </div>
    ${catErrLine()}
    <div class="row between g8 wrap">
      <button class="btn-danger" style="padding:10px 4px" ${act('askDeleteCat', oc.key)} ${list.length <= 1 ? 'disabled' : ''}>이 분야 삭제</button>
      <div class="row g8">
        <button class="btn-o" style="min-height:44px;padding:10px 18px" ${act('cancelEditCat')}>취소</button>
        <button class="btn sm" ${act('saveEditCat')} ${S.editCatName.trim() ? '' : 'disabled'}>저장</button>
      </div>
    </div>
    ${del}
    ${catSqlHint()}
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
    ${x(S.aiError, `<div class="notice caution" style="font-size:12.5px"><span><b>AI 연결 문제</b> · ${esc(S.aiError)}</span></div>`)}
    ${(() => { const p = live().filter(n => n.aiPending && !n.userSorted).length; return x(p, `<div class="row between g8 wrap" style="font-size:13px;color:var(--ink-2)"><span>간단 규칙으로만 분류된 글 ${p}편</span><button class="btn-o sm" style="min-height:38px;padding:6px 14px" ${act('reclassifyAll')} ${S.reclassBusy ? 'disabled' : ''}>${S.reclassBusy ? '정리하는 중…' : 'AI로 다시 정리'}</button></div>`); })()}
  </div>`;
  return `<div class="manage">
    <div class="label">내 기록 관리</div>
    ${syncBlock}
    <div class="row g8 wrap">
      ${x(s, `<button class="btn xs" ${act('syncNow')}>지금 동기화</button>`)}
      ${x(s, `<button class="btn-t" style="font-size:13.5px;padding:10px 8px" ${act('signOut')}>로그아웃</button>`)}
      <button class="btn-danger" ${act('resetAll')}>전체 초기화</button>
    </div>
    <div class="stack g8" style="margin-top:6px">
      <div class="label">내보내기</div>
      <div class="row g8 wrap">
        <button class="btn-o sm" ${act('exportXlsx')}>엑셀로 내보내기</button>
        <button class="btn-o sm" ${act('exportDocx')}>워드로 내보내기</button>
      </div>
      <div style="font-size:12.5px;color:var(--ink-3);line-height:1.6">엑셀은 표로 정렬·검색하기 좋고, 워드는 날짜순으로 읽거나 인쇄하기 좋아요. 주간 돌아보기와 블로그 글감도 함께 들어가요.</div>
    </div>
    <div class="stack g8" style="margin-top:6px">
      <div class="label">복원용 백업</div>
      <div class="row g8 wrap">
        <button class="btn-o sm" ${act('exportData')}>백업 파일 받기(JSON)</button>
        <button class="btn-o sm" ${act('importClick')}>백업 불러오기</button>
      </div>
      <div style="font-size:12.5px;color:var(--ink-3);line-height:1.6">앱으로 다시 불러올 수 있는 건 이 백업 파일(.json)뿐이에요. 엑셀·워드 파일은 불러올 수 없어요.</div>
    </div>
    ${x(sync.configured(), `<div style="font-size:12px;color:var(--ink-3);line-height:1.6">Gemini 무료 등급은 입력한 글이 서비스 개선에 쓰일 수 있어요. 육아·개인 기록이 많다면 유료 등급이나 Claude로 바꾸는 걸 권해요.</div>`)}
  </div>`;
}

function noteRow(n, { showPath } = {}) {
  const c = catOf(n.cat);
  return `<div class="note-row" ${act('openNote', n.id)}>
    <div class="meta">${fmt(n.date)} · ${showPath ? `${c.emoji} ${c.name} › ` : ''}${esc(n.sub)}</div>
    ${x(n.book, `<div style="font-size:13px;color:var(--ink-2)">📖 『${esc(n.book && n.book.title)}』${n.book && n.book.author ? ' ' + esc(n.book.author) : ''}</div>`)}
    <div class="sum">${esc(titleOf(n.body))}</div>
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
    ${x(!S.bodyEditing, `<div class="row g10 wrap">${each(n.tags, t => `<span style="font-size:14px;color:var(--accent)">#${esc(t)}</span>`)}${x(!n.tags.length, `<span style="font-size:13px;color:var(--ink-3)">태그 없음</span>`)}</div>`)}
  </div>
  ${x(n.book, `<div class="row g16" style="border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0">
    <div class="book-shape lg"></div>
    <div class="stack g4" style="min-width:0"><div class="serif" style="font-size:18px;font-weight:700;line-height:1.4">『${esc(n.book && n.book.title)}』</div><div style="font-size:13.5px;color:var(--ink-2);line-height:1.5">${esc(n.book ? bookMeta(n.book) : '')}</div></div>
  </div>`)}
  ${S.bodyEditing ? `<div class="stack g12">
    <textarea class="edit-body" data-in="bodyDraft" data-kd="bodyDraft" aria-label="글 수정">${taText(S.bodyDraft)}</textarea>
    <div class="tag-edit">
      <label class="row g10" style="font-size:14px;color:var(--ink-2)"><span class="label" style="letter-spacing:0.06em">작성 날짜</span>
        <input type="date" class="field" style="flex:0 0 auto;min-height:40px;padding:6px 12px" max="${todayS()}" value="${esc(S.bodyDate || n.date)}" data-in="bodyDate" ${act('openDatePicker')}></label>
      <div class="label" style="letter-spacing:0.06em">태그</div>
      <div class="row g6 wrap">
        ${each(S.tagsDraft, t => `<button class="tag-chip" aria-label="태그 ${esc(t)} 지우기" ${act('removeTagDraft', t)}>#${esc(t)} <span>×</span></button>`)}
        ${S.tagsDraft.length < 8 ? `<input class="dashed w" placeholder="+ 태그 추가" aria-label="태그 추가" value="${esc(S.newTagDraft)}" data-in="newTagDraft" data-kd="newTagDraft">
        ${x(S.newTagDraft.trim(), `<button class="chip ink on" ${act('addTagDraft')}>추가</button>`)}` : ''}
      </div>
      <div style="font-size:12px;color:var(--ink-3)">×를 누르면 지워지고, 새 태그는 쓰고 Enter(또는 쉼표·띄어쓰기). 최대 8개.</div>
    </div>
    <div class="row between g8 wrap">
      <button class="btn-danger" style="padding:10px 4px" ${act('deleteNote')}>글 삭제</button>
      <div class="row g8"><button class="btn-o" style="min-height:46px;padding:12px 18px" ${act('cancelBodyEdit')}>취소</button>${x(S.bodyDraft.trim(), `<button class="btn" style="min-height:46px;padding:12px 24px;font-size:14.5px" ${act('saveBody')}>수정 저장</button>`)}</div>
    </div>
  </div>` : `<div class="stack g18">
    ${x(n.edited, `<div style="font-size:12.5px;color:var(--ink-3)">${n.edited ? rel(n.edited) : ''} 수정</div>`)}
    ${each(n.body.split('\n').filter(p => p.trim()), p => `<p class="para">${esc(p)}</p>`)}
  </div>`}
  ${x(n.checks && n.checks.length, `<div class="card checks stack"><div class="label" style="color:var(--ink-2);padding-bottom:8px">아직 확인하지 않은 내용</div>${vChecks(n.checks, 'note')}</div>`)}
  <div class="stack g4" style="margin-top:12px">
    <h2 class="serif" style="margin:0 0 8px;font-size:20px;font-weight:700">이 글과 관련된 생각</h2>
    ${rels.length ? each(rels, r => { const rc = catOf(r.n.cat); return `<div class="rel-row" ${act('openNote', r.n.id)}>
      <div class="row g8 wrap" style="font-size:12.5px;color:var(--ink-3)"><span class="reason">${esc(r.reason)}</span><span>${rc.emoji} ${rc.name} › ${esc(r.n.sub)} · ${fmt(r.n.date)}</span></div>
      <div class="serif" style="font-size:16.5px;line-height:1.5">${esc(titleOf(r.n.body))}</div></div>`; }) : `<div style="font-size:14px;color:var(--ink-3);padding:8px 0">아직 이어진 생각이 없어요. 글이 쌓이면 같은 태그·갈래끼리 이어져요.</div>`}
  </div>
</article>`;
}

// 블로그 초안의 아주 단순한 마크다운: 제목줄(#)과 목록(-)만 구분하고 나머지는 문단
function mdLite(text) {
  const out = []; let para = [], list = [];
  const flushP = () => { if (para.length) { out.push(`<p class="md-p">${esc(para.join(' ').replace(/\*\*/g, ''))}</p>`); para = []; } };
  const flushL = () => { if (list.length) { out.push(`<ul class="md-ul">${list.map(li => `<li>${esc(li.replace(/\*\*/g, ''))}</li>`).join('')}</ul>`); list = []; } };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { flushP(); flushL(); continue; }
    if (/^#{1,4}\s/.test(line)) { flushP(); flushL(); out.push(`<h4 class="md-h">${esc(line.replace(/^#+\s*/, ''))}</h4>`); continue; }
    if (/^([-*]|\d+\.)\s/.test(line)) { flushP(); list.push(line.replace(/^([-*]|\d+\.)\s*/, '')); continue; }
    flushL(); para.push(line);
  }
  flushP(); flushL();
  return out.join('');
}

function vReport(r, open) {
  const label = weekLabel(r.date) + (r.final ? '' : ' (진행 중)');
  const head = `<div class="row between g8 wk-head" ${act('openReport', r.id)}>
      <span class="stack g4"><span class="serif" style="font-size:18px;font-weight:700">${label}</span>
      <span style="font-size:12.5px;color:var(--ink-3)">기록 ${r.noteCount || (r.noteIds || []).length}편 · 연결 ${(r.connections || []).length}개${r.blog ? ' · 글감 1개' : ''}</span></span>
      <span class="link-accent">${open ? '접기' : '펼치기'}</span>
    </div>`;
  if (!open) return `<div class="wk-card">${head}</div>`;
  const noteLink = id => { const n = findNote(id); return n ? `<button class="wk-note" ${act('openNote', n.id)}><span>${shortDate(n.date)}</span>${esc(titleOf(n.body))}</button>` : ''; };
  const conns = (r.connections || []).length ? each(r.connections, c => `<div class="wk-conn">
      <div style="font-size:15px;font-weight:700">${esc(c.title)}</div>
      <div class="serif pretty" style="font-size:15.5px;line-height:1.75;color:var(--ink)">${esc(c.insight)}</div>
      <div class="stack g4">${each(c.ids, noteLink)}</div>
    </div>`) : `<div style="font-size:14px;color:var(--ink-3)">이번 주에는 뚜렷하게 이어지는 생각을 찾지 못했어요.</div>`;
  const b = r.blog;
  const blog = b ? `<div class="wk-blog">
      <div class="label">✍️ 블로그 글감</div>
      <div class="serif" style="font-size:20px;font-weight:700;line-height:1.45">${esc(b.title)}</div>
      ${x(b.hook, `<div class="serif pretty" style="font-size:15.5px;line-height:1.75;color:var(--ink-2)">${esc(b.hook)}</div>`)}
      ${x(b.outline.length, `<ol class="wk-outline">${each(b.outline, o => `<li>${esc(o)}</li>`)}</ol>`)}
      ${S.blogOpen === r.id ? `<div class="wk-draft">${mdLite(b.draft)}</div>` : ''}
      ${x(b.tags.length, `<div class="tags">${each(b.tags, t => `<span>#${esc(t)}</span>`)}</div>`)}
      ${x((b.sourceIds || []).length, `<div class="stack g4"><span style="font-size:12px;color:var(--ink-3)">바탕이 된 기록</span>${each(b.sourceIds, noteLink)}</div>`)}
      <div class="row g8 wrap">
        <button class="btn-o sm" ${act('blogOpen', r.id)}>${S.blogOpen === r.id ? '본문 접기' : '본문 초안 보기'}</button>
        <button class="btn xs" ${act('copyBlog', r.id)}>전체 복사</button>
      </div>
      <div style="font-size:12px;color:var(--ink-3);line-height:1.6">AI가 기록을 바탕으로 쓴 초안이에요. 사실과 표현을 확인하고, 이름 같은 개인정보가 없는지 본 뒤 올려 주세요.</div>
    </div>` : `<div class="wk-blog"><div class="label">✍️ 블로그 글감</div><div style="font-size:14px;color:var(--ink-3)">이번 주에는 공개하기 좋은 글감을 찾지 못했어요.</div></div>`;
  return `<div class="wk-card open">
    ${head}
    ${x(r.overview, `<div class="serif pretty wk-overview">${esc(r.overview)}</div>`)}
    <div class="stack g12"><div class="label">🔗 생각의 연결고리</div>${conns}</div>
    ${blog}
    <div class="row between g8 wrap" style="font-size:12px;color:var(--ink-3)">
      <span>${new Date(r.generatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}에 만듦</span>
      <button class="btn-t" style="font-size:12.5px;color:var(--ink-3)" ${act('weeklyRedo', r.date)} ${S.weeklyBusy ? 'disabled' : ''}>다시 만들기</button>
    </div>
  </div>`;
}

function vWeekly() {
  const list = reports();
  const thisMon = mondayOf(todayS());
  const thisWeekCount = weekNotes(thisMon).length;
  const busy = S.weeklyBusy ? `<div class="card row g10" style="padding:16px 18px;font-size:14.5px;color:var(--ink-2)"><span class="dot pulse"></span>${weekLabel(S.weeklyBusy)} 생각을 읽고 연결고리와 글감을 찾는 중… (1분쯤 걸려요)</div>` : '';
  const canAI = sync.configured() && sync.session();
  const intro = !canAI
    ? `<div style="font-size:13.5px;color:var(--ink-2);line-height:1.65">로그인하면 매주 한 번, 지난주 생각들 사이의 연결고리와 통찰을 정리하고 블로그에 올릴 만한 글감 하나를 만들어 드려요.</div>`
    : `<div style="font-size:13px;color:var(--ink-3);line-height:1.6">매주 새 주에 처음 열 때 지난주 기록을 자동으로 돌아봐요.</div>`;
  const openId = openReportId();
  return `<div class="stack g12">
    <div class="row between g8" style="align-items:baseline">
      <div class="label">주간 돌아보기</div>
      ${x(canAI && thisWeekCount && !S.weeklyBusy, `<button class="link-accent" ${act('weeklyNow')}>이번 주 지금 돌아보기</button>`)}
    </div>
    ${intro}
    ${busy}
    ${each(list.slice(0, 8), r => vReport(r, r.id === openId))}
  </div>`;
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
  ${vWeekly()}
  ${x(!all.length, `<div class="serif" style="font-size:18px;line-height:1.7;color:var(--ink-2)">아직 흐름이 없어요. 생각을 몇 개 남기면 날짜순 흐름과 한 달 돌아보기가 여기에 생겨요.</div>`)}
  ${month}
  <div class="stack">${each(groups.slice(0, 120), g => `<div class="tl-group">
    <div class="tl-day"><span class="serif" style="font-size:18px;font-weight:700">${g.day}</span><span style="font-size:12px;color:var(--ink-3)">${g.dow}</span></div>
    <div class="tl-list">${each(g.notes, n => { const c = catOf(n.cat); return `<div class="tl-item" ${act('openNote', n.id)}><div style="font-size:12.5px;color:var(--ink-3)">${c.emoji} ${c.name} › ${esc(n.sub)}</div><div class="serif" style="font-size:17px;line-height:1.5">${esc(titleOf(n.body))}</div></div>`; })}</div>
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
      ${each(list, m => `<div class="row g12" style="padding:12px 0;border-top:1px solid var(--hover);align-items:baseline" ${act('openNote', m.id)}><span style="font-size:12.5px;color:var(--ink-3);flex-shrink:0">${shortDate(m.date)}</span><span class="serif" style="font-size:15.5px;line-height:1.5">${esc(titleOf(m.body))}</span></div>`)}
    </div>`;
  }
  return `<div class="stack g12"><div class="net"><svg aria-hidden="true">${lines}</svg>${dots}</div>${sel}</div>`;
}

function vSearch() {
  const q = S.query.trim();
  const isNL = /더라|했었|썼지|언제|뭐라|어떻게|\?|？|있었/.test(q);
  const all = sorted();
  let results = [];
  if (q) { const k = q.replace(/^#/, ''); results = isNL ? nlScore(q, all) : all.filter(n => [n.body, n.tags.join(' '), n.sub, catOf(n.cat).name, n.book ? n.book.title : ''].join(' ').includes(k)); }
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
    <div class="stack">${each(ansNotes, n => `<div class="row g12" style="padding:12px 0;border-top:1px solid var(--line);align-items:baseline" ${act('openNote', n.id)}><span style="font-size:12.5px;color:var(--ink-3);flex-shrink:0">${shortDate(n.date)}</span><span style="font-size:14.5px;color:var(--accent);line-height:1.5">${esc(titleOf(n.body))} →</span></div>`)}</div>
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
  ai.onError = msg => set({ aiError: msg });
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
  showNextUnconfirmed();
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
