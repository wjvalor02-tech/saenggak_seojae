// AI 호출은 모두 서버 함수 하나(/functions/v1/ai)를 거친다. API 키는 클라이언트에 없다.
// 서버가 없거나 실패하면 휴리스틱으로 대체하고, 기록은 절대 막지 않는다.
import { sync } from './sync.js';
import { catOf } from './util.js';

export const TAG_RULES = [[/달리|러닝|km|조깅/, '러닝'], [/스쿼트|근력|PT|헬스/, '근력운동'], [/부진/, '학습부진'], [/중재/, '중재연구'], [/사료|자료/, '사료'], [/연표|연대/, '연대기'], [/루브릭/, '루브릭'], [/서술형|채점/, '서술형평가'], [/도입/, '도입활동'], [/시간/, '시간개념'], [/말|단어|언어/, '언어발달'], [/인물/, '인물학습'], [/사고력|역사적 사고/, '역사적사고'], [/기초선/, '기초선'], [/질문|발문/, '발문'], [/모둠|협동/, '모둠활동'], [/잠|재우/, '잠자리'], [/책/, '책'], [/조선/, '조선'], [/고려/, '고려'], [/근대|개항/, '근대']];

export function heuristic(text) {
  let cat = 'daily', sub = '생각';
  if (/아이|딸|아들|육아|어린이집|서윤/.test(text)) { cat = 'parent'; sub = /잠|재우|밥|씻/.test(text) ? '잠·생활' : '말·언어'; }
  else if (/달리|러닝|km|조깅|스쿼트|헬스|PT|근력|수영|운동|자전거|사이클|프레스|덤벨|바벨|트레드밀|걷기/.test(text)) {
    cat = 'exercise';
    const cardio = /달리|러닝|km|조깅|자전거|사이클|수영|걷기|트레드밀|천국의계단|스텝퍼|유산소|로잉/.test(text);
    const strength = /스쿼트|근력|프레스|데드|벤치|덤벨|바벨|PT|헬스|머신|컬|풀업/.test(text);
    sub = cardio && strength ? '근력+유산소' : cardio ? '유산소' : '근력';
  }
  else if (/논문|연구|중재|설계|측정|분석|세미나|선행/.test(text)) { cat = 'research'; sub = /논문|리뷰/.test(text) ? '논문 읽기' : /방법|설계|기초선|질적|양적/.test(text) ? '교육방법론' : '역사교육'; }
  else if (/수업|학생|단원|평가|루브릭|차시|도입|반 /.test(text)) { cat = 'class'; sub = /평가|루브릭|채점|시험/.test(text) ? '평가' : '한국사 수업'; }
  else if (/책|읽고|읽었|저자|밑줄/.test(text)) { cat = 'reading'; sub = /역사/.test(text) ? '역사' : '교육'; }
  else if (/몸|목|허리|잠|피곤/.test(text)) { sub = '몸'; }
  let tags = TAG_RULES.filter(([re]) => re.test(text)).map(([, t]) => t).slice(0, 3);
  if (tags.length < 2) {
    const words = text.replace(/[^가-힣a-zA-Z\s]/g, ' ').split(/\s+/)
      .map(w => w.replace(/(에서|에게|으로|이나|하고|에는|이다|했다|한다|은|는|이|가|을|를|에|의|도|로|와|과)$/, ''))
      .filter(w => w.length >= 2 && !tags.includes(w));
    words.sort((a, b) => b.length - a.length);
    tags = [...tags, ...words.slice(0, 2 - tags.length)];
  }
  const first = text.split(/[.\n!?]/)[0].trim();
  const summary = first.length > 34 ? first.slice(0, 33) + '…' : first;
  return { cat, sub, tags, summary };
}

// 서버 호출. 실패하면 null
async function call(task, input, timeoutMs = 18000) {
  if (!sync.canUseAI()) return null;
  try {
    const r = await sync.invokeAI({ task, input }, timeoutMs);
    if (r && r.usage != null) ai.onUsage && ai.onUsage(r);
    return r && r.result ? r : null;
  } catch (e) {
    return null;
  }
}

export const ai = {
  onUsage: null,
  available: () => sync.canUseAI(),

  // → { cat, sub, tags, summary, aiPending?, aiProvider? }
  async classify(text, cats, book) {
    const taxonomy = cats.map(c => `${c.key}(${c.name}): ${c.subs.map(s => s.name).join(', ')}`).join('\n');
    const bookLine = book ? `[이 글은 책 『${book.title}』${book.author ? `(${book.author})` : ''}에 관한 기록]\n` : '';
    const r = await call('classify', { text: bookLine + text, taxonomy, keys: cats.map(c => c.key) });
    if (r) {
      const j = r.result;
      if (cats.find(c => c.key === j.cat) && j.sub && Array.isArray(j.tags) && j.summary) {
        return {
          cat: j.cat, sub: String(j.sub).trim(),
          tags: j.tags.map(t => String(t).replace(/^#/, '').replace(/\s/g, '')).filter(Boolean).slice(0, 4),
          summary: String(j.summary), aiProvider: r.provider,
        };
      }
    }
    const h = heuristic(text);
    if (book && h.cat !== 'research' && h.cat !== 'class') { h.cat = 'reading'; h.sub = /역사/.test(text) ? '역사' : '교육'; }
    return { ...h, aiPending: true };
  },

  async findBook(text, cand) {
    const r = await call('book', { text: text.slice(0, 800), cand });
    if (!r) return undefined; // 사용 불가 / 실패
    const b = r.result.book;
    if (!b || !b.title) return null;
    const out = {};
    ['title', 'author', 'translator', 'publisher', 'year', 'originalYear'].forEach(k => { if (b[k]) out[k] = String(b[k]); });
    return out;
  },

  async factCheck(text) {
    const r = await call('check', { text: text.slice(0, 3000) }, 25000);
    if (!r) return null;
    return (r.result.checks || []).filter(c => c && c.issue).slice(0, 5).map(c => ({
      quote: String(c.quote || ''), level: c.level === '오류 가능' ? '오류 가능' : '확인 권장', issue: String(c.issue), note: String(c.note || ''),
    }));
  },

  async ask(q, candidates) {
    const ctx = candidates.map(n => `[${n.id}] ${n.date} | ${catOf(n.cat).name}›${n.sub} | ${n.summary} | ${n.body.slice(0, 180).replace(/\n/g, ' ')}`).join('\n');
    const r = await call('ask', { q, ctx });
    if (!r || !r.result.answer) return null;
    return { text: String(r.result.answer), ids: (r.result.ids || []).map(String) };
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
    const hay = [n.body, n.summary, n.tags.join(' '), n.sub, catOf(n.cat).name].join(' ');
    let s = 0;
    toks.forEach(t => { if (hay.includes(t)) s += 2; else if (t.length >= 3 && hay.includes(t.slice(0, 2))) s += 1; });
    return { n, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.n);
}
