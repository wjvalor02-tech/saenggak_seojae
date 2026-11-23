// 의미 유사도(임베딩) 도우미.
// 글마다 AI가 계산한 '의미 숫자 묶음'(768개)을 작게 압축해 글 안(note.emb)에 저장한다.
// → 다른 기기와 자동 동기화되고(서버 표 변경 없음), 비슷한 글 찾기는 기기 안에서 바로 계산한다.

// 글 내용이 바뀌었는지 알아보는 짧은 지문(FNV-1a)
export function hashText(s) {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// 저장용: 길이를 1로 맞춘 뒤(-1~1) 각 숫자를 -127~127 정수 1바이트로 → base64(768바이트 ≈ 1KB 글자)
export function packVec(v, model, text) {
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  const b = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) b[i] = Math.max(-127, Math.min(127, Math.round((v[i] / n) * 127)));
  let s = ''; const u = new Uint8Array(b.buffer);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return { m: model || '', d: v.length, h: hashText(text), v: btoa(s) };
}

const cache = new Map(); // note.id → { h, f(Float32Array, 길이 1) }
function unpack(emb) {
  const raw = atob(emb.v);
  const b = new Int8Array(raw.length);
  for (let i = 0; i < raw.length; i++) b[i] = (raw.charCodeAt(i) << 24) >> 24;
  const f = new Float32Array(b.length);
  let n = 0; for (let i = 0; i < b.length; i++) { f[i] = b[i]; n += b[i] * b[i]; }
  n = Math.sqrt(n) || 1; for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}
// 이 글의 의미 벡터(본문이 바뀌어 낡았으면 null)
export function vecOf(note) {
  const e = note && note.emb;
  if (!e || !e.v || e.h !== hashText(note.body)) return null;
  const c = cache.get(note.id);
  if (c && c.h === e.h && c.v === e.v) return c.f;
  try { const f = unpack(e); cache.set(note.id, { h: e.h, v: e.v, f }); return f; } catch (x) { return null; }
}
export function toUnit(v) {
  const f = Float32Array.from(v); let n = 0; for (const x of f) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n; return f;
}
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
// 가장 비슷한 글 k편: [{ n, sim }]
export function nearest(vec, notes, k = 8, excludeId = null) {
  if (!vec) return [];
  const out = [];
  for (const n of notes) {
    if (n.id === excludeId) continue;
    const v = vecOf(n); if (!v) continue;
    out.push({ n, sim: cosine(vec, v) });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, k);
}

// 비슷한 글들의 분류로 투표(가까울수록 큰 표). 결과: { cat, sub, conf(0~1), voters }
export function voteCategory(neigh) {
  const w = x => Math.pow(Math.max(0, x.sim), 4);
  const cat = {}, sub = {};
  let total = 0;
  for (const x of neigh) { const ww = w(x); total += ww; cat[x.n.cat] = (cat[x.n.cat] || 0) + ww; const k = x.n.cat + '\u0001' + x.n.sub; sub[k] = (sub[k] || 0) + ww; }
  const best = Object.entries(cat).sort((a, b) => b[1] - a[1])[0];
  if (!best || !total) return null;
  const bestSub = Object.entries(sub).filter(([k]) => k.startsWith(best[0] + '\u0001')).sort((a, b) => b[1] - a[1])[0];
  return { cat: best[0], sub: bestSub ? bestSub[0].split('\u0001')[1] : null, conf: best[1] / total, voters: neigh.length };
}

// 비슷한 글들이 쓴 태그를 점수 매기기(가까울수록, 여러 글에서 쓸수록 높음)
export function tagCandidates(neigh, exclude = []) {
  const ex = new Set(exclude);
  const score = {}, cnt = {};
  for (const x of neigh) for (const t of x.n.tags || []) {
    if (ex.has(t)) continue;
    score[t] = (score[t] || 0) + Math.max(0, x.sim); cnt[t] = (cnt[t] || 0) + 1;
  }
  return Object.entries(score).map(([t, s]) => ({ t, s, c: cnt[t] })).sort((a, b) => b.s - a.s);
}

// 태그가 글에 실제로 나오는지(띄어쓰기 무시). 지어낸 태그를 걸러내는 데 쓴다.
const squash = s => String(s).replace(/\s+/g, '').toLowerCase();
export function appearsIn(tag, text) { const t = squash(tag); return t.length >= 2 && squash(text).includes(t); }
