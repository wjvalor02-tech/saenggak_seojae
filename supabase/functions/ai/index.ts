// Supabase Edge Function: POST /functions/v1/ai  { task, input }
// task: classify | book | check | ask | weekly. 로그인한 사용자 토큰이 있어야 호출된다(verify_jwt 기본값).
import { completeJSON, provider } from "./complete.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const isObj = (j: unknown): j is Record<string, unknown> => !!j && typeof j === "object" && !Array.isArray(j);
const str = (v: unknown, max = 4000) => String(v ?? "").slice(0, max);

const PROFILE = "사용자는 역사 교사이자 교육방법 전공 대학원생이고, 수업 아이디어·연구 메모·독서·육아·일상·운동 글을 쓴다.";

const tasks: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  // 분류: 분야(사용자가 정한 목록 중 하나) + 갈래 + 태그. 요약은 만들지 않는다.
  classify(input) {
    const keys = Array.isArray(input.keys) ? input.keys.map(String) : [];
    const vocab = str(input.vocab, 1200);
    const examples = str(input.examples, 2500);
    const prompt = `너는 개인 생각 기록 앱의 분류기다. ${PROFILE}

[분야 목록과 지금까지 자란 갈래] (형식: key(분야 이름): 갈래, 갈래…)
${str(input.taxonomy)}
${vocab ? `\n[이 사용자가 이미 쓰는 태그] (같은 뜻이면 반드시 이 표기를 그대로 다시 쓴다)\n${vocab}\n` : ""}${examples ? `\n[사용자가 직접 고친 분류 예시] (이 사람의 기준이니 비슷한 글은 똑같이 분류한다)\n${examples}\n` : ""}
[분류할 글]
"""${str(input.text, 6000)}"""

규칙
1. cat: 위 분야 key 중 정확히 하나. 글의 '주된 목적'으로 고른다(예: 수업에서 쓸 책 이야기 → 수업, 개인적 감상 → 독서).
2. sub: 기존 갈래 중 맞는 것이 있으면 그대로 쓴다. 정말 없을 때만 새 이름(2~6자, 명사)을 만든다. 성격이 다른 내용이 섞이면 둘을 아우르는 갈래(예: 근력+유산소)를 고른다.
3. tags: 2~3개. 나중에 이 태그로 '비슷한 생각'을 다시 찾을 수 있도록, 글의 핵심 주제·개념·대상을 나타내는 띄어쓰기 없는 명사.
   - 좋은 예: 학습부진, 사료학습, 역사적사고, 수면습관, 인터벌러닝
   - 나쁜 예: 오늘, 생각, 수업(분야 이름과 같은 말), 했다, 좋았다, 날짜·감정어·동사·형용사
   - 이미 쓰는 태그 중 뜻이 같은 것이 있으면 새로 만들지 말고 그것을 쓴다.
JSON만 출력: {"cat":"","sub":"","tags":[]}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && keys.includes(String(j.cat)) && !!j.sub && Array.isArray(j.tags), 25000, { effort: "low" });
  },
  book(input) {
    const cand = input.cand ? str(input.cand, 80) : "";
    const prompt = `다음 글에서 사용자가 읽고 있거나 언급한 책 한 권을 찾아 서지 정보를 알려줘.${cand ? ` 사용자가 표시한 제목: "${cand}".` : ""}\n글:\n"""${str(input.text, 800)}"""\n\n특정 책이 없거나 실제 존재하는 책인지 확신할 수 없으면 {"book":null}. 한국어판이 있으면 한국어판 기준(번역자·출판사·출간연도). 원서 출간연도는 originalYear. JSON만 출력: {"book":{"title":"","author":"","translator":"","publisher":"","year":"","originalYear":""}}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && "book" in j, 20000, { effort: "low" });
  },
  check(input) {
    const prompt = `너는 역사 교사이자 교육방법 전공 대학원생의 개인 메모를 읽는 꼼꼼한 검토자다. 아래 글에서 사실관계를 확인해 볼 필요가 있는 부분(연도·인물·사건·수치·인용문·연구 결과·학자 이름·책 정보 등)을 찾아라. 개인 경험·감정·의견·계획은 검토 대상이 아니다. 틀렸다고 확신할 때만 level을 "오류 가능"으로, 나머지는 "확인 권장"으로 한다. 사소한 것은 빼고 최대 5개. 없으면 빈 배열.\n글:\n"""${str(input.text, 3000)}"""\n\nJSON만 출력: {"checks":[{"quote":"글에서 해당 부분을 그대로 30자 이내로","level":"오류 가능 또는 확인 권장","issue":"무엇을 확인해야 하는지 한 문장","note":"알고 있는 사실이나 확인할 방법 한 문장"}]}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && Array.isArray(j.checks), 40000, { effort: "medium" });
  },
  ask(input) {
    const prompt = `아래는 한 사람의 생각 기록이다.\n${str(input.ctx, 16000)}\n\n질문: "${str(input.q, 300)}"\n\n기록에 근거해 2~3문장으로, 본인에게 말하듯 존댓말로 답한다. 날짜를 '11월 10일'처럼 언급한다. 관련 기록 id를 최대 3개. JSON만 출력: {"answer":"","ids":[]}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && typeof j.answer === "string", 28000, { effort: "low" });
  },

  // 주간 검토: 그 주의 생각 사이 연결고리·통찰 + 블로그 글감 하나
  weekly(input) {
    const prompt = `너는 한 사람의 개인 생각 기록을 매주 함께 돌아보는 사려 깊은 동료다. ${PROFILE}

[이번 주(${str(input.range, 40)}) 기록] (형식: [id] 날짜 | 분야›갈래 | #태그 | 본문)
${str(input.week, 24000)}
${input.past ? `\n[참고: 지난 기록 제목들] (이번 주 생각과 이어지는 게 있을 때만 언급)\n${str(input.past, 4000)}\n` : ""}
할 일 1 — 생각의 연결고리
- 서로 다른 날·다른 분야의 기록 사이에서, 본인이 미처 의식하지 못했을 수 있는 연결을 최대 3개 찾는다.
- 같은 태그라서 묶이는 뻔한 연결보다, 다른 분야끼리 같은 질문·패턴·긴장을 공유하는 연결을 우선한다(예: 아이의 언어 발달 관찰 ↔ 학습부진 학생 중재).
- 각 연결은 ids(이번 주 기록 id 2개 이상, 지난 기록 id도 가능), title(15자 이내), insight(2~3문장, 왜 이어지는지와 그래서 무엇을 해 볼 수 있는지)를 담는다.
- 억지 연결은 만들지 않는다. 진짜 연결이 없으면 빈 배열.
할 일 2 — 이번 주 한 줄 통찰
- overview: 이번 주 생각 전체를 관통하는 흐름이나 질문을 2~3문장으로. 칭찬·평가 말투는 피하고 관찰처럼 쓴다.
할 일 3 — 블로그 글감 하나
- 공개 블로그에 올릴 만한 생각거리 하나를 고른다. 교육·역사·배움·성장처럼 다른 사람에게도 의미 있는 것을 우선한다.
- 개인정보 보호: 아이·학생·동료의 이름, 학교 이름, 사적인 가족 사정 등은 쓰지 않거나 일반화한다(예: '우리 반 한 학생').
- blog.title(독자가 클릭하고 싶은 제목), blog.hook(첫 문단 1~2문장), blog.outline(소제목 3~5개), blog.draft(본문 초안 900~1400자, 마크다운, 1인칭, 기록에 실제로 있는 경험과 생각에 근거하고 없는 사실을 지어내지 않는다), blog.tags(3~5개), blog.sourceIds(근거가 된 기록 id).
- 공유할 만한 것이 정말 없으면 blog는 null.
JSON만 출력:
{"overview":"","connections":[{"ids":[],"title":"","insight":""}],"blog":{"title":"","hook":"","outline":[],"draft":"","tags":[],"sourceIds":[]}}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && typeof j.overview === "string" && Array.isArray(j.connections), 130000, { effort: "medium", maxTokens: 6000 });
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: { task?: string; input?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const fn = tasks[String(body.task)];
  if (!fn || !isObj(body.input)) return json({ error: "bad task" }, 400);

  // 하루 호출 수 상한(비용 보호). 사용자 토큰으로 RPC를 불러 본인 행만 갱신한다.
  const limit = Number(Deno.env.get("AI_DAILY_LIMIT") || 300);
  let usedToday = 0;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/bump_ai_usage`, {
      method: "POST",
      headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", Authorization: req.headers.get("Authorization") ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ p_task: body.task }),
    });
    if (r.ok) usedToday = Number(await r.json()) || 0;
  } catch { /* 기록 실패는 무시 */ }
  if (usedToday > limit) return json({ error: "daily_limit", detail: `하루 AI 호출 상한(${limit}회)을 넘었어요.` }, 429);

  try {
    const result = await fn(body.input);
    return json({ result, provider: provider(), usage: usedToday });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(body.task, msg);
    // 앱이 원인을 보여 줄 수 있게 짧은 이유를 함께 돌려준다(키 값 같은 비밀은 들어가지 않음)
    return json({ error: "ai_failed", task: body.task, detail: `${body.task}: ${msg}`.slice(0, 240), provider: provider() }, 502);
  }
});
