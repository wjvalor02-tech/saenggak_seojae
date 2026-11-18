// AI 호출은 모두 서버 함수 하나(/functions/v1/ai)를 거친다. API 키는 클라이언트에 없다.
// 서버가 없거나 실패하면 간단 규칙으로 대체하고, 기록은 절대 막지 않는다.
// 실패하면 이유(lastError)를 남겨 서재 화면에 보여 준다.
import { sync } from './sync.js';
import { catOf } from './util.js';

export const TAG_RULES = [[/달리|러닝|km|조깅/, '러닝'], [/스쿼트|근력|PT|헬스/, '근력운동'], [/부진/, '학습부진'], [/중재/, '중재연구'], [/사료/, '사료학습'], [/연표|연대/, '연대기'], [/루브릭/, '루브릭'], [/서술형|채점/, '서술형평가'], [/도입 ?활동/, '도입활동'], [/시간 ?개념/, '시간개념'], [/단어|언어|말을 /, '언어발달'], [/인물/, '인물학습'], [/사고력|역사적 ?사고/, '역사적사고'], [/기초선/, '기초선'], [/발문/, '발문'], [/모둠|협동/, '모둠활동'], [/잠자리|재우/, '수면습관'], [/조선/, '조선'], [/고려/, '고려'], [/근대|개항/, '근대']];

export const oneLine = t => String(t).replace(/\s+/g, ' ').trim();
export function isShort(text) {
  const t = oneLine(text);
  const sentences = String(text).split(/(?<=[.!?。？！…])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  return sentences.length <= 2 && t.length <= 90;
}
// 목록에 보이는 제목: AI 요약 대신 글의 첫 문장(짧은 글은 글 전체)
export function titleOf(text) {
  const t = oneLine(text);
  if (isShort(text)) return t;
  const first = (String(text).split(/(?<=[.!?。？！])\s+|\n+/).map(s => s.trim()).find(Boolean) || t);
  return first.length > 48 ? first.slice(0, 47) + '…' : first;
}

// AI가 없을 때의 간단 분류. 태그는 확실한 규칙에 걸리는 것만 붙인다
// (예전엔 글에서 긴 낱말을 그대로 태그로 삼아 '#차가웠다' 같은 이상한 태그가 생겼다).
export function heuristic(text) {
  let cat = 'daily', sub = '생각';
  if (/아이가|아이는|아이와|딸|아들|육아|어린이집/.test(text)) { cat = 'parent'; sub = /잠|재우|밥|씻/.test(text) ? '잠·생활' : '말·언어'; }
  else if (/달리|러닝|km|조깅|스쿼트|헬스|PT|근력|수영|운동|자전거|사이클|프레스|덤벨|바벨|트레드밀/.test(text)) {
    cat = 'exercise';
    const cardio = /달리|러닝|km|조깅|자전거|사이클|수영|걷기|트레드밀|천국의계단|스텝퍼|유산소|로잉/.test(text);
    const strength = /스쿼트|근력|프레스|데드|벤치|덤벨|바벨|PT|헬스|머신|컬|풀업/.test(text);
    sub = cardio && strength ? '근력+유산소' : cardio ? '유산소' : '근력';
  }
  else if (/논문|연구|중재|설계|측정|분석|세미나|선행/.test(text)) { cat = 'research'; sub = /논문|리뷰/.test(text) ? '논문 읽기' : /방법|설계|기초선|질적|양적/.test(text) ? '교육방법론' : '역사교육'; }
  else if (/수업|학생|단원|평가|루브릭|차시|도입|반 /.test(text)) { cat = 'class'; sub = /평가|루브릭|채점|시험/.test(text) ? '평가' : '한국사 수업'; }
  else if (/책|읽고|읽었|저자|밑줄/.test(text)) { cat = 'reading'; sub = /역사/.test(text) ? '역사' : '교육'; }
  else if (/몸|목|허리|잠|피곤/.test(text)) { sub = '몸'; }
  const tags = TAG_RULES.filter(([re]) => re.test(text)).map(([, t]) => t).slice(0, 3);
  return { cat, sub, tags };
}

// 서버 호출. 실패하면 null을 돌려주고 ai.lastError에 이유를 남긴다
async function call(task, input, timeoutMs = 18000) {
  if (!sync.configured()) { ai.lastError = null; return null; }
  if (!sync.session()) { ai.setError('로그인하지 않아서 AI를 쓰지 못했어요.'); return null; }
  if (!navigator.onLine) return null; // 오프라인은 오류로 치지 않는다(연결되면 다시 정리)
  try {
    const r = await sync.invokeAI({ task, input }, timeoutMs);
    if (r && r.failed) { ai.setError(explain(r)); return null; }
    if (r && r.result) { ai.setError(null); if (r.usage != null && ai.onUsage) ai.onUsage(r); return r; }
    ai.setError('AI 응답을 읽지 못했어요.');
    return null;
  } catch (e) {
    ai.setError(e && e.name === 'AbortError' ? `${TASK_NAME[task] || 'AI'} 응답을 ${Math.round(timeoutMs / 1000)}초 기다렸지만 오지 않았어요.` : 'AI 서버에 연결하지 못했어요.');
    return null;
  }
}
const TASK_NAME = { classify: '글 분류', book: '책 찾기', check: 'AI 검토', ask: '물어보기', weekly: '주간 돌아보기' };
function explain(r) {
  const d = String(r.detail || '');
  const task = TASK_NAME[r.task] || TASK_NAME[d.split(':')[0]] || '';
  const sec = (d.match(/(\d+)초/) || [])[1];
  if (/timeout/.test(d)) return `${task ? task + ' 중 ' : ''}AI가 ${sec ? sec + '초 안에 ' : '제시간에 '}답하지 않았어요. 잠시 뒤 다시 정리할게요.`;
  if (r.status === 401) return '로그인이 만료돼 AI를 쓰지 못했어요. 다시 로그인해 주세요.';
  if (r.status === 404) return 'AI 서버 함수(ai)가 Supabase에 배포돼 있지 않아요.';
  if (r.status === 429) return d || 'AI 사용 한도를 넘었어요. 내일 다시 정리할게요.';
  if (/GEMINI_API_KEY missing|ANTHROPIC_API_KEY missing/.test(d)) return 'Supabase에 AI 키(비밀값)가 설정돼 있지 않아요.';
  if (/gemini 5\d\d/.test(d)) return `${task ? task + ' 중 ' : ''}Google Gemini 서버가 혼잡해서 기본 모델과 예비 모델 모두 응답하지 않았어요. 잠시 뒤 다시 정리할게요.`;
  if (/gemini 404/.test(d)) return `Gemini 모델을 찾을 수 없어요. AI_MODEL 비밀값을 확인해 주세요. (${d})`;
  if (/gemini 40[03]/.test(d)) return `Gemini가 요청을 거절했어요. 키·모델 권한을 확인해 주세요. (${d})`;
  if (/rate_limited/.test(d)) return 'AI 제공자의 무료 한도를 넘었어요. 잠시 뒤 다시 정리할게요.';
  return `AI 정리에 실패했어요${d ? `: ${d}` : '.'}`;
}

export const ai = {
  onUsage: null,
  onError: null,
  lastError: null,
  setError(msg) { if (this.lastError !== msg) { this.lastError = msg; this.onError && this.onError(msg); } },
  available: () => sync.canUseAI(),

  // → { cat, sub, tags, summary, aiPending?, aiProvider? }
  // summary는 AI 요약이 아니라 글에서 뽑은 제목(목록·검색에 쓰임)
  // hints: { vocab: 자주 쓰는 태그 목록, examples: 사용자가 직접 고친 분류 예시 }
  async classify(text, cats, book, hints = {}) {
    const r = await this._classify(text, cats, book, hints);
    r.summary = titleOf(text);
    return r;
  },

  async _classify(text, cats, book, hints) {
    const taxonomy = cats.map(c => `${c.key}(${c.name}): ${c.subs.map(s => s.name).join(', ') || '(아직 없음)'}`).join('\n');
    const bookLine = book ? `[이 글은 책 『${book.title}』${book.author ? `(${book.author})` : ''}에 관한 기록]\n` : '';
    const r = await call('classify', { text: bookLine + text, taxonomy, keys: cats.map(c => c.key), vocab: hints.vocab || '', examples: hints.examples || '' }, 30000);
    if (r) {
      const j = r.result;
      if (cats.find(c => c.key === j.cat) && j.sub && Array.isArray(j.tags)) {
        const catName = (cats.find(c => c.key === j.cat) || {}).name;
        return {
          cat: j.cat, sub: String(j.sub).trim().slice(0, 12),
          // 분야 이름과 같은 태그·한 글자 태그는 걸러 낸다
          tags: [...new Set(j.tags.map(t => String(t).replace(/^#/, '').replace(/\s/g, '')).filter(t => t.length >= 2 && t !== catName))].slice(0, 3),
          aiProvider: r.provider,
        };
      }
      ai.setError('AI가 알 수 없는 분야로 답해 간단히 분류했어요.');
    }
    return this.guess(text, cats, book);
  },

  // AI 없이 바로 내는 간단 분류(AI가 늦거나 실패할 때). aiPending이 붙어 나중에 AI로 다시 정리된다
  guess(text, cats, book) {
    const h = heuristic(text);
    if (book && h.cat !== 'research' && h.cat !== 'class') { h.cat = 'reading'; h.sub = /역사/.test(text) ? '역사' : '교육'; }
    // 사용자가 지운 기본 분야로 분류됐으면, 이름이 같은 분야나 '일상', 그것도 없으면 첫 분야로
    if (!cats.find(c => c.key === h.cat)) {
      const want = { research: '연구', class: '수업', reading: '독서', parent: '육아', daily: '일상', exercise: '운동' }[h.cat];
      const alt = cats.find(c => c.name === want) || cats.find(c => c.key === 'daily') || cats[0];
      h.cat = alt.key; h.sub = h.sub || '생각';
    }
    return { ...h, aiPending: true, summary: titleOf(text) };
  },

  async findBook(text, cand) {
    const r = await call('book', { text: text.slice(0, 800), cand }, 25000);
    if (!r) return undefined; // 사용 불가 / 실패
    const b = r.result.book;
    if (!b || !b.title) return null;
    const out = {};
    ['title', 'author', 'translator', 'publisher', 'year', 'originalYear'].forEach(k => { if (b[k]) out[k] = String(b[k]); });
    return out;
  },

  async factCheck(text) {
    const r = await call('check', { text: text.slice(0, 3000) }, 45000);
    if (!r) return null;
    return (r.result.checks || []).filter(c => c && c.issue).slice(0, 5).map(c => ({
      quote: String(c.quote || ''), level: c.level === '오류 가능' ? '오류 가능' : '확인 권장', issue: String(c.issue), note: String(c.note || ''),
    }));
  },

  async ask(q, candidates) {
    const ctx = candidates.map(n => `[${n.id}] ${n.date} | ${catOf(n.cat).name}›${n.sub} | ${titleOf(n.body)} | ${n.body.slice(0, 180).replace(/\n/g, ' ')}`).join('\n');
    const r = await call('ask', { q, ctx }, 33000);
    if (!r || !r.result.answer) return null;
    return { text: String(r.result.answer), ids: (r.result.ids || []).map(String) };
  },

  // 주간 검토: { overview, connections:[{ids,title,insight}], blog:{title,hook,outline,draft,tags,sourceIds}|null }
  async weekly(weekNotes, pastNotes, range) {
    const week = weekNotes.map(n => `[${n.id}] ${n.date} | ${catOf(n.cat).name}›${n.sub} | ${n.tags.map(t => '#' + t).join(' ')} | ${n.body.slice(0, 1200).replace(/\n+/g, ' ')}`).join('\n');
    const past = pastNotes.map(n => `[${n.id}] ${n.date} | ${catOf(n.cat).name} | ${titleOf(n.body)} | ${n.tags.map(t => '#' + t).join(' ')}`).join('\n');
    const r = await call('weekly', { week, past, range }, 145000);
    if (!r) return null;
    const j = r.result;
    const ids = new Set([...weekNotes, ...pastNotes].map(n => n.id));
    const s = (v, max) => String(v ?? '').slice(0, max);
    const conns = (Array.isArray(j.connections) ? j.connections : []).map(c => ({
      ids: (Array.isArray(c.ids) ? c.ids.map(String) : []).filter(id => ids.has(id)),
      title: s(c.title, 40), insight: s(c.insight, 600),
    })).filter(c => c.ids.length >= 2 && c.insight).slice(0, 3);
    const b = j.blog && typeof j.blog === 'object' && j.blog.draft ? {
      title: s(j.blog.title, 120), hook: s(j.blog.hook, 400),
      outline: (Array.isArray(j.blog.outline) ? j.blog.outline : []).map(o => s(o, 80)).slice(0, 6),
      draft: s(j.blog.draft, 6000), tags: (Array.isArray(j.blog.tags) ? j.blog.tags : []).map(t => s(t, 20).replace(/^#/, '')).slice(0, 6),
      sourceIds: (Array.isArray(j.blog.sourceIds) ? j.blog.sourceIds.map(String) : []).filter(id => ids.has(id)),
    } : null;
    return { overview: s(j.overview, 800), connections: conns, blog: b, provider: r.provider };
  },
};

// 자연어 검색용 토큰/점수 (AI 없이도 동작, AI에 보낼 후보 추리기에도 사용)
export function tokens(q) {
  return q.replace(/[?？“”"']/g, ' ').split(/\s+/)
    .map(w => w.replace(/(에 대해|에대해|에서|이라고|라고|했었|했지|썼더라|썼지|더라|에는|은|는|이|가|을|를|에|의|도|로)$/, ''))
    .filter(w => w.length >= 2 && !/그때|뭐라고|언제|어떻게|썼더라|얘기|대해|관해|무엇|뭐라/.test(w));
}
export function nlScore(q, notes) {
  const toks = tokens(q);
  return notes.map(n => {
    const hay = [n.body, n.tags.join(' '), n.sub, catOf(n.cat).name].join(' ');
    let s = 0;
    toks.forEach(t => { if (hay.includes(t)) s += 2; else if (t.length >= 3 && hay.includes(t.slice(0, 2))) s += 1; });
    return { n, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.n);
}
