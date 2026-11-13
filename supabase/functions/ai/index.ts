// Supabase Edge Function: POST /functions/v1/ai  { task, input }
// task: classify | book | check | ask. 로그인한 사용자 토큰이 있어야 호출된다(verify_jwt 기본값).
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
  classify(input) {
    const keys = Array.isArray(input.keys) ? input.keys.map(String) : [];
    const prompt = `너는 개인 생각 기록 앱의 분류기다. ${PROFILE}\n기존 분류 체계:\n${str(input.taxonomy)}\n\n글:\n"""${str(input.text, 6000)}"""\n\n기존 분야 key 중 하나를 고른다. 하위 갈래는 기존 것을 우선 쓰되, 정말 맞는 게 없으면 새 이름(2~6자)을 만든다. 한 글에 성격이 다른 내용이 섞이면(예: 근력운동과 유산소운동) 한쪽으로 몰지 말고 둘을 아우르는 갈래(예: 근력+유산소)를 고른다. 태그는 2~3개, 띄어쓰기 없는 명사. ${input.short ? '짧은 글이라 요약하지 않는다. summary는 빈 문자열.' : '요약은 30자 이내 한 줄, 명사형으로 끝낸다.'} JSON만 출력: {"cat":"","sub":"","tags":[],"summary":""}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && keys.includes(String(j.cat)) && !!j.sub && Array.isArray(j.tags) && (!!input.short || !!j.summary), 15000);
  },
  book(input) {
    const cand = input.cand ? str(input.cand, 80) : "";
    const prompt = `다음 글에서 사용자가 읽고 있거나 언급한 책 한 권을 찾아 서지 정보를 알려줘.${cand ? ` 사용자가 표시한 제목: "${cand}".` : ""}\n글:\n"""${str(input.text, 800)}"""\n\n특정 책이 없거나 실제 존재하는 책인지 확신할 수 없으면 {"book":null}. 한국어판이 있으면 한국어판 기준(번역자·출판사·출간연도). 원서 출간연도는 originalYear. JSON만 출력: {"book":{"title":"","author":"","translator":"","publisher":"","year":"","originalYear":""}}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && "book" in j, 15000);
  },
  check(input) {
    const prompt = `너는 역사 교사이자 교육방법 전공 대학원생의 개인 메모를 읽는 꼼꼼한 검토자다. 아래 글에서 사실관계를 확인해 볼 필요가 있는 부분(연도·인물·사건·수치·인용문·연구 결과·학자 이름·책 정보 등)을 찾아라. 개인 경험·감정·의견·계획은 검토 대상이 아니다. 틀렸다고 확신할 때만 level을 "오류 가능"으로, 나머지는 "확인 권장"으로 한다. 사소한 것은 빼고 최대 5개. 없으면 빈 배열.\n글:\n"""${str(input.text, 3000)}"""\n\nJSON만 출력: {"checks":[{"quote":"글에서 해당 부분을 그대로 30자 이내로","level":"오류 가능 또는 확인 권장","issue":"무엇을 확인해야 하는지 한 문장","note":"알고 있는 사실이나 확인할 방법 한 문장"}]}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && Array.isArray(j.checks), 22000);
  },
  ask(input) {
    const prompt = `아래는 한 사람의 생각 기록이다.\n${str(input.ctx, 16000)}\n\n질문: "${str(input.q, 300)}"\n\n기록에 근거해 2~3문장으로, 본인에게 말하듯 존댓말로 답한다. 날짜를 '11월 10일'처럼 언급한다. 관련 기록 id를 최대 3개. JSON만 출력: {"answer":"","ids":[]}`;
    return completeJSON(prompt, (j): j is unknown => isObj(j) && typeof j.answer === "string", 18000);
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
  if (usedToday > limit) return json({ error: "daily_limit" }, 429);

  try {
    const result = await fn(body.input);
    return json({ result, provider: provider(), usage: usedToday });
  } catch (e) {
    console.error(body.task, e instanceof Error ? e.message : e);
    return json({ error: "ai_failed" }, 502); // 앱은 휴리스틱으로 대체하고 나중에 다시 정리
  }
});
