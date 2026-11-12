// 아주 작은 DOM 패치기: 새 HTML 문자열을 기존 DOM에 맞춰 덮어쓴다.
// 포커스·커서·스크롤을 지키기 위해 같은 자리의 같은 태그는 재사용한다.

export function morph(root, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  patchChildren(root, tpl.content);
}

function patchChildren(parent, next) {
  const a = Array.from(parent.childNodes);
  const b = Array.from(next.childNodes);
  for (let i = 0; i < b.length; i++) {
    const old = a[i];
    const nu = b[i];
    if (!old) { parent.appendChild(nu); continue; }
    if (!same(old, nu)) { parent.replaceChild(nu, old); continue; }
    patchNode(old, nu);
  }
  for (let i = b.length; i < a.length; i++) parent.removeChild(a[i]);
}

function same(x, y) {
  if (x.nodeType !== y.nodeType) return false;
  if (x.nodeType !== 1) return true;
  if (x.nodeName !== y.nodeName) return false;
  // key가 다르면 새로 만든다
  const kx = x.getAttribute('data-key'), ky = y.getAttribute('data-key');
  return kx === ky;
}

function patchNode(el, nu) {
  if (el.nodeType === 3 || el.nodeType === 8) {
    if (el.nodeValue !== nu.nodeValue) el.nodeValue = nu.nodeValue;
    return;
  }
  // 속성
  for (const { name } of Array.from(el.attributes)) {
    if (!nu.hasAttribute(name)) el.removeAttribute(name);
  }
  for (const { name, value } of Array.from(nu.attributes)) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  const tag = el.nodeName;
  if (tag === 'TEXTAREA') {
    const v = nu.value;
    if (el.value !== v) el.value = v;
    return;
  }
  if (tag === 'INPUT') {
    const v = nu.getAttribute('value') ?? '';
    if (el.type !== 'file' && el.value !== v) el.value = v;
    return;
  }
  if (el.hasAttribute('data-keep')) return; // 직접 관리하는 영역
  patchChildren(el, nu);
}

// HTML 이스케이프
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
