// 흐름 화면의 네트워크 지도: 분야(큰 원)–태그(작은 점) 힘 기반 배치. 데이터가 같으면 결과를 재사용한다.
let memoKey = null, memo = null;

export function layoutNet(mNotes) {
  const key = mNotes.map(n => n.id + n.cat + n.tags.join(',')).join('|');
  if (memoKey === key) return memo;
  const catCount = {}, tagCount = {}, link = {};
  mNotes.forEach(n => {
    catCount[n.cat] = (catCount[n.cat] || 0) + 1;
    n.tags.forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; const k = n.cat + '\u0001' + t; link[k] = (link[k] || 0) + 1; });
  });
  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .filter(([, c], i) => c >= 2 || i < 6).slice(0, 10).map(x => x[0]);
  const cats = Object.keys(catCount);
  const nodes = [
    ...cats.map((k, i) => {
      const a = i / cats.length * Math.PI * 2 - Math.PI / 2, r = cats.length > 1 ? 0.28 : 0;
      return { id: 'c:' + k, type: 'cat', key: k, count: catCount[k], x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) };
    }),
    ...tags.map(t => ({ id: 't:' + t, type: 'tag', key: t, count: tagCount[t], x: 0.5, y: 0.5 })),
  ];
  const idx = {}; nodes.forEach((n, i) => { idx[n.id] = i; });
  const edges = [];
  Object.entries(link).forEach(([k, w]) => { const [c, t] = k.split('\u0001'); if (idx['t:' + t] !== undefined) edges.push({ a: idx['c:' + c], b: idx['t:' + t], w }); });
  nodes.forEach((n, i) => {
    if (n.type !== 'tag') return;
    const ls = edges.filter(e => e.b === i).map(e => nodes[e.a]);
    let h = 7; for (const ch of n.key) h = (h * 31 + ch.charCodeAt(0)) % 997;
    const ang = h / 997 * Math.PI * 2;
    n.x = ls.reduce((s, m) => s + m.x, 0) / ls.length + Math.cos(ang) * 0.12;
    n.y = ls.reduce((s, m) => s + m.y, 0) / ls.length + Math.sin(ang) * 0.12;
  });
  const N = 320;
  for (let it = 0; it < N; it++) {
    const cool = 1 - it / N, fx = nodes.map(() => 0), fy = nodes.map(() => 0);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y, d2 = dx * dx + dy * dy + 1e-4, d = Math.sqrt(d2);
      const k = nodes[i].type === 'cat' && nodes[j].type === 'cat' ? 0.010 : nodes[i].type === 'cat' || nodes[j].type === 'cat' ? 0.004 : 0.0025;
      const f = k / d2; fx[i] += dx / d * f; fy[i] += dy / d * f; fx[j] -= dx / d * f; fy[j] -= dy / d * f;
    }
    edges.forEach(e => {
      const A = nodes[e.a], B = nodes[e.b], dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) + 1e-6, f = (d - 0.2) * 0.12;
      fx[e.a] += dx / d * f; fy[e.a] += dy / d * f; fx[e.b] -= dx / d * f; fy[e.b] -= dy / d * f;
    });
    nodes.forEach((n, i) => {
      fx[i] += (0.5 - n.x) * 0.02; fy[i] += (0.5 - n.y) * 0.02;
      const lim = 0.03 * cool + 0.002;
      n.x = Math.min(0.86, Math.max(0.14, n.x + Math.max(-lim, Math.min(lim, fx[i]))));
      n.y = Math.min(0.85, Math.max(0.13, n.y + Math.max(-lim, Math.min(lim, fy[i]))));
    });
  }
  memoKey = key; memo = { nodes, edges };
  return memo;
}
