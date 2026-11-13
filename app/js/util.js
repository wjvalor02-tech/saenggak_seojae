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

// 분야: 처음엔 기본 6개로 시작하고, 사용자가 서재 → 분야 관리에서 추가·삭제할 수 있다.
// 갈래는 여전히 AI가 글에 맞춰 키운다.
export const DEFAULT_CATS = [
  { key: 'research', hue: 160, name: '연구', emoji: '📚' },
  { key: 'class', hue: 60, name: '수업', emoji: '✏️' },
  { key: 'reading', hue: 25, name: '독서', emoji: '📖' },
  { key: 'parent', hue: 125, name: '육아', emoji: '🌱' },
  { key: 'daily', hue: 290, name: '일상', emoji: '☕' },
  { key: 'exercise', hue: 225, name: '운동', emoji: '🏃' },
];
export const MAX_CATS = 12;
const HUES = [160, 60, 25, 125, 290, 225, 340, 95, 195, 260, 10, 45, 140, 310, 180, 75];

// 사용자가 입력한 이름·이모지는 화면에 그대로 끼워 넣으므로 HTML 문자를 미리 걸러 둔다
const clean = (s, max) => String(s ?? '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanCat = c => ({
  key: clean(c.key, 40).replace(/[^\w-]/g, '') || 'c_' + Math.random().toString(36).slice(2, 8),
  name: clean(c.name, 10) || '분야',
  emoji: clean(c.emoji, 8) || '📁',
  hue: Number.isFinite(+c.hue) ? Math.round(+c.hue) % 360 : 160,
});

let CUR = DEFAULT_CATS;
export const getCats = () => CUR;
export function setCats(list) {
  const seen = new Set();
  const out = (Array.isArray(list) ? list : []).map(cleanCat).filter(c => !seen.has(c.key) && seen.add(c.key));
  CUR = out.length ? out : DEFAULT_CATS;
  return CUR;
}
export const nextHue = () => HUES.find(h => !CUR.some(c => c.hue === h)) ?? Math.floor(Math.random() * 360);
// 삭제된 분야를 가리키는 글이 남아 있어도 화면이 깨지지 않게 대체값을 준다
export const catOf = key => CUR.find(c => c.key === key) || { key, name: '분류 안 됨', emoji: '📁', hue: 60 };
export const catColor = hue => `oklch(0.42 0.06 ${hue})`;

export const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const bookMeta = b => [
  b.author,
  b.translator && `${b.translator} 옮김`,
  b.publisher,
  b.year && (b.originalYear && b.originalYear !== b.year ? `${b.year} (원서 ${b.originalYear})` : b.year),
].filter(Boolean).join(' · ');
