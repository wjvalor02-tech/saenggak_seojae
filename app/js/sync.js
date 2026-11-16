// Supabase 동기화 (SDK 없이 REST로). config.js에 URL/키가 비어 있으면 로컬 전용 모드.
import { db, clean } from './store.js';

const cfg = () => (window.SEOJAE_CONFIG || {});
// 'https://xxx.supabase.co/rest/v1/'처럼 API 경로까지 붙여 넣어도 프로젝트 주소만 쓴다
const base = () => (cfg().supabaseUrl || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth|functions)\/v1$/, '');
const anon = () => cfg().supabaseAnonKey || '';

let session = null; // { access_token, refresh_token, expires_at, user: { id, email } }
let syncing = null;
let catsSupported = null;
let listeners = [];
let status = { state: 'idle', at: null, error: null }; // idle | syncing | ok | offline | error

function emit() { listeners.forEach(f => f()); }
function setStatus(p) { status = { ...status, ...p }; emit(); }

async function authFetch(path, opts = {}) {
  await ensureFresh();
  const headers = { apikey: anon(), 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (session) headers.Authorization = `Bearer ${session.access_token}`;
  const r = await fetch(base() + path, { ...opts, headers });
  if (r.status === 401 && session) {
    // 토큰이 막 만료됐을 수 있다 → 한 번 갱신 후 재시도
    if (await refresh()) {
      headers.Authorization = `Bearer ${session.access_token}`;
      return fetch(base() + path, { ...opts, headers });
    }
  }
  return r;
}

async function saveSession(s) {
  session = s;
  if (s) await db.set('session', s); else await db.del('session');
  emit();
}

// 로그인 유지 원칙: 사용자가 로그아웃하지 않는 한 세션을 지우지 않는다.
// 오프라인·서버 오류·일시적 실패에서는 기존 세션을 그대로 두고 다음에 다시 갱신한다.
// 서버가 "이 갱신 토큰은 더는 유효하지 않다"고 분명히 답할 때만 세션을 내려놓는다.
const DEAD_TOKEN = /refresh_token_not_found|refresh_token_already_used|session_not_found|session_expired|user_not_found|user_banned|invalid refresh token|refresh token is not valid/i;
const nowS = () => Date.now() / 1000;
const fresh = s => s && s.expires_at && s.expires_at - 300 > nowS();

// 여러 탭이 동시에 갱신하면 갱신 토큰이 '이미 사용됨'이 될 수 있어 탭 간 잠금으로 한 번에 하나만
function withLock(fn) {
  if (navigator.locks && navigator.locks.request) return navigator.locks.request('seojae-auth-refresh', fn);
  return fn();
}

async function refresh() {
  if (!session || !session.refresh_token) return false;
  return withLock(async () => {
    // 다른 탭이 방금 갱신했으면 그 세션을 그대로 쓴다
    const stored = await db.get('session').catch(() => null);
    if (stored && stored.refresh_token !== session.refresh_token && fresh(stored)) { session = stored; emit(); return true; }
    if (!stored && session) { /* 다른 탭에서 로그아웃 */ session = null; emit(); return false; }
    try {
      const r = await fetch(`${base()}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: anon(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const msg = [j.error_code, j.code, j.error, j.msg, j.message, j.error_description].filter(Boolean).join(' ');
        if ((r.status === 400 || r.status === 401) && DEAD_TOKEN.test(msg)) {
          // 갱신 토큰이 정말 끝났다 → 다시 로그인해야 함(이 기기의 기록은 그대로 남음)
          await saveSession(null);
          setStatus({ state: 'error', error: '로그인이 만료됐어요. 다시 로그인하면 이어서 동기화돼요.' });
        }
        return false;
      }
      const j = await r.json();
      await saveSession(fromAuthResponse(j, session.user));
      return true;
    } catch (e) { return false; } // 오프라인이면 기존 세션 유지
  });
}

async function ensureFresh() {
  if (session && !fresh(session) && navigator.onLine) await refresh();
}

function fromAuthResponse(j, fallbackUser) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600),
    user: j.user ? { id: j.user.id, email: j.user.email } : fallbackUser || null,
  };
}

export const sync = {
  configured: () => !!(base() && anon()),
  catsSupported: () => catsSupported, // null: 아직 모름, true/false: 서버에 분야 열이 있는지
  session: () => session,
  status: () => status,
  subscribe(f) { listeners.push(f); return () => { listeners = listeners.filter(x => x !== f); }; },

  async init() {
    if (!this.configured()) return;
    session = (await db.get('session')) || null;
    // 매직링크로 돌아온 경우: #access_token=...
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('access_token')) {
      const s = fromAuthResponse({ access_token: h.get('access_token'), refresh_token: h.get('refresh_token'), expires_in: h.get('expires_in'), expires_at: Number(h.get('expires_at')) || undefined });
      history.replaceState(null, '', location.pathname + location.search);
      session = s;
      try {
        const r = await fetch(`${base()}/auth/v1/user`, { headers: { apikey: anon(), Authorization: `Bearer ${s.access_token}` } });
        if (r.ok) { const u = await r.json(); s.user = { id: u.id, email: u.email }; }
      } catch (e) { /* 무시 */ }
      await saveSession(s);
    } else if (h.get('error_description')) {
      history.replaceState(null, '', location.pathname + location.search);
      setStatus({ state: 'error', error: '로그인 링크가 만료됐거나 잘못됐어요. 다시 받아 주세요.' });
    }
    emit();
    this.keepAlive();
  },

  // 앱이 열려 있는 동안 토큰을 미리미리 갱신해 둔다(만료 5분 전, 앱으로 돌아올 때, 다시 온라인이 될 때)
  keepAlive() {
    if (this._alive) return;
    this._alive = true;
    const tick = async () => {
      // 메일 링크를 다른 탭에서 눌러 로그인한 경우 그 세션을 이 탭도 이어받는다
      if (!session) { const s = await db.get('session').catch(() => null); if (s) { session = s; emit(); } }
      ensureFresh().catch(() => {});
    };
    tick();
    setInterval(tick, 4 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
    window.addEventListener('online', tick);
  },

  async sendLink(email) {
    const redirect = location.origin + location.pathname;
    const r = await fetch(`${base()}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
      method: 'POST', headers: { apikey: anon(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.msg || j.error_description || '메일을 보내지 못했어요.');
    }
  },

  // 처음 가입하는 주소는 'Confirm signup' 메일의 코드, 이미 가입한 주소는 'Magic Link' 메일의 코드가 온다.
  // 'email' 유형이 둘 다 처리하지만, 혹시 실패하면 'signup' 유형으로 한 번 더 확인한다.
  async verifyCode(email, token) {
    let j = {};
    for (const type of ['email', 'signup']) {
      const r = await fetch(`${base()}/auth/v1/verify`, {
        method: 'POST', headers: { apikey: anon(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, email, token }),
      });
      j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) { await saveSession(fromAuthResponse(j)); return; }
    }
    throw new Error('코드가 맞지 않거나 만료됐어요. 메일을 다시 받아 가장 최근 코드를 넣어 주세요.');
  },

  async signOut() {
    try { await authFetch('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* 무시 */ }
    await saveSession(null);
    await db.del('lastPull');
    setStatus({ state: 'idle', at: null, error: null });
  },

  canUseAI() { return this.configured() && !!session && navigator.onLine; },

  async invokeAI(body, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await authFetch('/functions/v1/ai', { method: 'POST', body: JSON.stringify(body), signal: ctl.signal });
      // 실패해도 이유를 돌려줘서 화면에 보여 줄 수 있게 한다(예전엔 조용히 간단 분류로만 넘어갔음)
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { failed: true, status: r.status, error: j.error, detail: j.detail || j.message || '' }; }
      return await r.json();
    } finally { clearTimeout(t); }
  },

  // 양방향 동기화. app은 { getNotes, applyRemote(notes), markClean(ids, stamps), getSubBorn, setSubBorn } 제공
  async run(app) {
    if (!this.configured() || !session) return;
    if (!navigator.onLine) { setStatus({ state: 'offline' }); return; }
    if (syncing) return syncing;
    syncing = (async () => {
      setStatus({ state: 'syncing', error: null });
      try {
        // 1) 받기: 서버 기준 시각(synced_at)으로 증분
        const lastPull = (await db.get('lastPull')) || '1970-01-01T00:00:00Z';
        let maxPull = lastPull;
        const remote = [];
        for (let offset = 0; ; offset += 500) {
          const r = await authFetch(`/rest/v1/notes?select=id,data,updated_at,deleted_at,synced_at&synced_at=gt.${encodeURIComponent(lastPull)}&order=synced_at.asc&limit=500&offset=${offset}`);
          if (!r.ok) throw new Error('pull ' + r.status);
          const rows = await r.json();
          rows.forEach(row => {
            remote.push({ ...row.data, id: row.id, updatedAt: row.updated_at, ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}) });
            if (row.synced_at > maxPull) maxPull = row.synced_at;
          });
          if (rows.length < 500) break;
        }
        if (remote.length) await app.applyRemote(remote);

        // 갈래 생일 + 분야 목록. 분야 열(cats)은 add-categories.sql을 실행해야 생기므로,
        // 없으면(400) 갈래 생일만 받고 분야 목록은 이 기기에만 둔다.
        let mr = await authFetch('/rest/v1/meta?select=sub_born,cats,cats_updated_at');
        if (mr.status === 400) { catsSupported = false; mr = await authFetch('/rest/v1/meta?select=sub_born'); }
        else if (mr.ok) catsSupported = true;
        if (mr.ok) {
          const row = (await mr.json())[0];
          if (row && row.sub_born) await app.mergeSubBorn(row.sub_born);
          if (row && row.cats && app.mergeCats) await app.mergeCats({ list: row.cats, updatedAt: row.cats_updated_at });
        }

        // 2) 보내기
        const dirty = app.getNotes().filter(n => n.dirty);
        for (let i = 0; i < dirty.length; i += 200) {
          const chunk = dirty.slice(i, i + 200);
          const body = chunk.map(n => {
            const { deletedAt, updatedAt, ...data } = clean(n);
            return { id: n.id, data, updated_at: updatedAt, deleted_at: deletedAt || null };
          });
          const r = await authFetch('/rest/v1/notes?on_conflict=id', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal,missing=default' }, body: JSON.stringify(body),
          });
          if (!r.ok) throw new Error('push ' + r.status);
          await app.markClean(chunk.map(n => [n.id, n.updatedAt]));
        }
        const sb = app.getSubBorn();
        await authFetch('/rest/v1/meta?on_conflict=user_id', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal,missing=default' },
          body: JSON.stringify([{ sub_born: sb }]),
        });
        const dc = catsSupported && app.getCatsDirty ? app.getCatsDirty() : null;
        if (dc) {
          const r = await authFetch('/rest/v1/meta?on_conflict=user_id', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal,missing=default' },
            body: JSON.stringify([{ cats: dc.list, cats_updated_at: dc.updatedAt }]),
          });
          if (r.ok) await app.markCatsClean(dc.updatedAt);
        }

        await db.set('lastPull', maxPull);
        setStatus({ state: 'ok', at: new Date().toISOString(), error: null });
      } catch (e) {
        const msg = !session ? '로그인이 만료됐어요. 다시 로그인하면 이어서 동기화돼요.' : navigator.onLine ? '동기화하지 못했어요. 잠시 후 다시 시도할게요.' : null;
        setStatus({ state: navigator.onLine ? 'error' : 'offline', error: msg });
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  },
};
