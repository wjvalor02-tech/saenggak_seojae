// 생각 지도: 글(점)과 글 사이의 연결(선)을 '의미'로 그린다.
// - 점의 위치: 의미 숫자(임베딩)를 2차원으로 펼친 것(주성분 분석) → 뜻이 비슷한 글이 가까이 놓인다.
//   그 위에 가벼운 힘 계산으로 겹친 점을 떼어 놓는다.
// - 선: 각 글에서 뜻이 가장 비슷한 글 몇 편(기준 이상), 그리고 사용자가 직접 이은 글.
// - 주제 섬: 서로 아주 비슷한 글들이 3편 이상 모인 무리. 이름은 AI가 붙인다(앱에서).
import { vecOf, cosine } from './sim.js';

export const EDGE_SIM = 0.62;   // 이 이상 비슷해야 선을 긋는다(관련된 생각 기준과 같음)
export const ISLAND_SIM = 0.7;  // 주제 섬으로 묶을 만큼 가까운 정도
const K = 3;                    // 글마다 그을 최대 '비슷함' 선 수

// 두 방향 모두 반영한 사용자 연결 목록
export function linkPairs(notes) {
  const ids = new Set(notes.map(n => n.id));
  const out = new Set();
  for (const n of notes) for (const m of n.links || []) if (ids.has(m) && m !== n.id) out.add(n.id < m ? n.id + '|' + m : m + '|' + n.id);
  return [...out].map(k => k.split('|'));
}

// 상위 2개 주성분(파워 반복). X: 길이 1인 벡터들
function pca2(X) {
  const n = X.length, d = X[0].length;
  const mean = new Float32Array(d);
  for (const v of X) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  const C = X.map(v => { const c = new Float32Array(d); for (let i = 0; i < d; i++) c[i] = v[i] - mean[i]; return c; });
  const comps = [];
  for (let k = 0; k < 2; k++) {
    let w = new Float32Array(d); for (let i = 0; i < d; i++) w[i] = Math.sin(i * (k + 1.7)); // 결정적 시작값
    for (let it = 0; it < 40; it++) {
      const s = C.map(c => { let t = 0; for (let i = 0; i < d; i++) t += c[i] * w[i]; return t; });
      const nw = new Float32Array(d);
      C.forEach((c, j) => { for (let i = 0; i < d; i++) nw[i] += c[i] * s[j]; });
      for (const p of comps) { let dot = 0; for (let i = 0; i < d; i++) dot += nw[i] * p[i]; for (let i = 0; i < d; i++) nw[i] -= dot * p[i]; }
      let norm = 0; for (let i = 0; i < d; i++) norm += nw[i] * nw[i]; norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < d; i++) nw[i] /= norm;
      w = nw;
    }
    comps.push(w);
  }
  return C.map(c => comps.map(w => { let t = 0; for (let i = 0; i < c.length; i++) t += c[i] * w[i]; return t; }));
}

let memoKey = null, memo = null;
// notes: 의미 분석이 된 글들(최대 150편 권장)
export function buildMap(notes) {
  const items = notes.map(n => ({ n, v: vecOf(n) })).filter(x => x.v);
  const key = items.map(x => x.n.id + ':' + x.n.emb.h + ':' + (x.n.links || []).join(',')).join('|');
  if (key === memoKey) return memo;
  const N = items.length;
  if (N < 3) { memoKey = key; memo = { nodes: [], edges: [], islands: [] }; return memo; }

  // 비슷함 행렬
  const S = items.map(() => new Float32Array(N));
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const s = cosine(items[i].v, items[j].v); S[i][j] = s; S[j][i] = s; }

  // 선: 글마다 가장 비슷한 K편(기준 이상) + 직접 이은 글
  const idx = new Map(items.map((x, i) => [x.n.id, i]));
  const edgeMap = new Map();
  const addEdge = (a, b, type) => { const k = a < b ? a + ',' + b : b + ',' + a; const e = edgeMap.get(k); if (e) { if (type === 'link') e.type = 'link'; return; } edgeMap.set(k, { a: Math.min(a, b), b: Math.max(a, b), sim: S[a][b], type }); };
  for (let i = 0; i < N; i++) {
    const order = [...Array(N).keys()].filter(j => j !== i).sort((p, q) => S[i][q] - S[i][p]);
    order.slice(0, K).filter(j => S[i][j] >= EDGE_SIM).forEach(j => addEdge(i, j, 'sim'));
  }
  for (const [a, b] of linkPairs(items.map(x => x.n))) if (idx.has(a) && idx.has(b)) addEdge(idx.get(a), idx.get(b), 'link');
  const edges = [...edgeMap.values()];

  // 위치: 주성분 2개 → 0.1~0.9 범위로, 그 뒤 힘 계산으로 겹침 풀기(선은 당기고 점끼리는 민다)
  const P = pca2(items.map(x => x.v));
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const nx = v => { const lo = Math.min(...xs), hi = Math.max(...xs); return hi - lo < 1e-6 ? 0.5 : 0.12 + 0.76 * (v - lo) / (hi - lo); };
  const ny = v => { const lo = Math.min(...ys), hi = Math.max(...ys); return hi - lo < 1e-6 ? 0.5 : 0.12 + 0.76 * (v - lo) / (hi - lo); };
  const pos = P.map(p => ({ x: nx(p[0]), y: ny(p[1]) }));
  const ITER = 160;
  for (let it = 0; it < ITER; it++) {
    const cool = 1 - it / ITER;
    const fx = new Float32Array(N), fy = new Float32Array(N);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y, d2 = dx * dx + dy * dy + 1e-4, d = Math.sqrt(d2);
      const f = 0.0009 / d2; fx[i] += dx / d * f; fy[i] += dy / d * f; fx[j] -= dx / d * f; fy[j] -= dy / d * f;
    }
    for (const e of edges) {
      const A = pos[e.a], B = pos[e.b], dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
      const f = (d - (e.type === 'link' ? 0.08 : 0.12)) * 0.05;
      fx[e.a] += dx / d * f; fy[e.a] += dy / d * f; fx[e.b] -= dx / d * f; fy[e.b] -= dy / d * f;
    }
    const lim = 0.02 * cool + 0.001;
    for (let i = 0; i < N; i++) {
      pos[i].x = Math.min(0.94, Math.max(0.06, pos[i].x + Math.max(-lim, Math.min(lim, fx[i]))));
      pos[i].y = Math.min(0.93, Math.max(0.07, pos[i].y + Math.max(-lim, Math.min(lim, fy[i]))));
    }
  }

  // 주제 섬: 뜻이 아주 비슷한 글끼리 이어진 무리(3편 이상). 큰 순서로 최대 6개.
  // (직접 이은 선은 서로 다른 주제를 잇는 경우가 많아 섬을 합치는 데 쓰지 않는다)
  const parent = [...Array(N).keys()];
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  edges.filter(e => e.sim >= ISLAND_SIM).forEach(e => { parent[find(e.a)] = find(e.b); });
  const groups = new Map();
  for (let i = 0; i < N; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const islands = [...groups.values()].filter(g => g.length >= 3).sort((a, b) => b.length - a.length).slice(0, 6).map(g => ({
    members: g.map(i => items[i].n.id),
    x: g.reduce((s, i) => s + pos[i].x, 0) / g.length,
    y: Math.max(0.05, Math.min(...g.map(i => pos[i].y)) - 0.06),
    sig: g.map(i => items[i].n.id).sort().slice(0, 6).join(',') + '#' + g.length,
  }));
  const islandOf = new Map(); islands.forEach((isl, k) => isl.members.forEach(id => islandOf.set(id, k)));

  memoKey = key;
  memo = { nodes: items.map((x, i) => ({ id: x.n.id, n: x.n, x: pos[i].x, y: pos[i].y, island: islandOf.has(x.n.id) ? islandOf.get(x.n.id) : -1 })), edges, islands };
  return memo;
}
