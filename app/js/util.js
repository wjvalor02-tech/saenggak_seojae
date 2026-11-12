export const DOW = '일월화수목금토';

export const todayS = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const daysAgo = s => Math.round((pd(todayS()) - pd(s)) / 864e5);
export const fmt = s => { const d = pd(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`; };
export const fmtPlain = s => { const d = pd(s); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
export const shortDate = s => { const d = pd(s); return `${d.getMonth() + 1}.${d.getDate()}`; };
export const rel = s => {
  const n = daysAgo(s);
  return n <= 0 ? '오늘' : n === 1 ? '어제' : n < 7 ? `${n}일 전` : n < 30 ? `${Math.floor(n / 7)}주 전` : `${Math.floor(n / 30)}달 전`;
};
export const todayLabel = () => fmt(todayS()).replace(/ \((.)\)/, ' $1요일');

// 분야는 고정(A안), 갈래만 자란다
export const CATS = [
  { key: 'research', hue: 160, name: '연구', emoji: '📚' },
  { key: 'class', hue: 60, name: '수업', emoji: '✏️' },
  { key: 'reading', hue: 25, name: '독서', emoji: '📖' },
  { key: 'parent', hue: 125, name: '육아', emoji: '🌱' },
  { key: 'daily', hue: 290, name: '일상', emoji: '☕' },
  { key: 'exercise', hue: 225, name: '운동', emoji: '🏃' },
];
export const catOf = key => CATS.find(c => c.key === key) || CATS[4];
export const catColor = hue => `oklch(0.42 0.06 ${hue})`;

export const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const bookMeta = b => [
  b.author,
  b.translator && `${b.translator} 옮김`,
  b.publisher,
  b.year && (b.originalYear && b.originalYear !== b.year ? `${b.year} (원서 ${b.originalYear})` : b.year),
].filter(Boolean).join(' · ');
