// Supabase 동기화 (SDK 없이 REST로). config.js에 URL/키가 비어 있으면 로컬 전용 모드.
import { db, clean } from './store.js';

const cfg = () => (window.SEOJAE_CONFIG || {});
const base = () => (cfg().supabaseUrl || '').replace(/\/$/, '');
const anon = () => cfg().supabaseAnonKey || '';

let session = null; // { access_token, refresh_token, expires_at, user: { id, email } }
let syncing = null;
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

async function refresh() {
  if (!session || !session.refresh_token) return false;
  try {
    const r = await fetch(`${base()}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: anon(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!r.ok) {
      if (r.status === 400 || r.status === 401) { await saveSession(null); }
      return false;
    }
    const j = await r.json();
    await saveSession(fromAuthResponse(j, session.user));
    return true;
  } catch (e) { return false; } // 오프라인이면 기존 세션 유지
}

async function ensureFresh() {
  if (session && session.expires_at && session.expires_at - 60 < Date.now() / 1000) await refresh();
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

  async verifyCode(email, token) {
    const r = await fetch(`${base()}/auth/v1/verify`, {
      method: 'POST', headers: { apikey: anon(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', email, token }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('코드가 맞지 않거나 만료됐어요.');
    await saveSession(fromAuthResponse(j));
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
      if (!r.ok) return null;
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

        const mr = await authFetch('/rest/v1/meta?select=sub_born');
        if (mr.ok) { const rows = await mr.json(); if (rows[0] && rows[0].sub_born) await app.mergeSubBorn(rows[0].sub_born); }

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

        await db.set('lastPull', maxPull);
        setStatus({ state: 'ok', at: new Date().toISOString(), error: null });
      } catch (e) {
        setStatus({ state: navigator.onLine ? 'error' : 'offline', error: navigator.onLine ? '동기화하지 못했어요. 잠시 후 다시 시도할게요.' : null });
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  },
};
