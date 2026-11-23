// Gemini 어댑터(기본). AI_PROVIDER=gemini 일 때 사용.
import type { CompleteOpts } from "../complete.ts";

// 모델 역할
// - 빠른 모델: 글 분류·책 찾기·물어보기처럼 짧고 자주 하는 일. 빠른 응답용으로 만든 Flash-Lite.
//   (로그에서 3.8 Flash가 짧은 분류에도 25초를 넘겨 실패하는 일이 잦았다)
// - 깊은 모델: 주간 돌아보기·사실 검토처럼 느려도 되는 일.
// - 임베딩 모델: 글의 의미를 숫자로 바꿔 '비슷한 글'을 찾는 데 쓴다.
// 모두 Supabase 비밀값으로 바꿀 수 있다: AI_FAST_MODEL, AI_MODEL, AI_EMBED_MODEL
export const FAST_MODEL = () => Deno.env.get("AI_FAST_MODEL") || "gemini-3.5-flash-lite";
export const DEEP_MODEL = () => Deno.env.get("AI_MODEL") || "gemini-3.8-flash";
const EMBED_MODEL = () => Deno.env.get("AI_EMBED_MODEL") || "gemini-embedding-2";
const EMBED_FALLBACK = "gemini-embedding-001";
export const EMBED_DIM = 768; // 3072를 768로 줄여도 품질이 거의 같다는 공식 안내(저장 공간 4분의 1)

type Res = { status: number; ok: boolean; json: any; timedOut?: boolean };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

// 응답 본문까지 다 받은 뒤 반환. 시간 안에 안 오면 timedOut으로 표시(예외 대신) → 다음 모델로 넘어갈 수 있게.
async function post(url: string, key: string, body: unknown, timeoutMs: number): Promise<Res> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs));
  try {
    const r = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, json };
  } catch (e) {
    if (ctl.signal.aborted) return { status: 0, ok: false, json: {}, timedOut: true };
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// 모델 하나로 요청. 선택 기능(생각 깊이·응답 형식 강제)을 모델이 모르면(400) 빼고 한 번 더.
async function tryModel(model: string, key: string, prompt: string, opts: CompleteOpts, timeoutMs: number): Promise<Res> {
  const base: Record<string, unknown> = {};
  if (opts.json) base.responseMimeType = "application/json";
  if (opts.maxTokens) base.maxOutputTokens = opts.maxTokens;
  const extra: Record<string, unknown> = {};
  if (opts.effort) extra.thinkingConfig = { thinkingLevel: opts.effort };
  if (opts.schema) extra.responseJsonSchema = opts.schema; // 답을 정해진 모양(예: 분야 목록 중 하나)으로 강제
  const body = (cfg: Record<string, unknown>) => ({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: cfg });
  const start = Date.now();
  let r = await post(`${BASE}${encodeURIComponent(model)}:generateContent`, key, body({ ...base, ...extra }), timeoutMs);
  if (r.status === 400 && Object.keys(extra).length && timeoutMs - (Date.now() - start) > 2000) {
    console.warn(`${model}: 선택 기능 거부됨(${Object.keys(extra).join(",")}), 빼고 다시:`, String(r.json?.error?.message ?? "").slice(0, 120));
    r = await post(`${BASE}${encodeURIComponent(model)}:generateContent`, key, body(base), timeoutMs - (Date.now() - start));
  }
  return r;
}

const busy = (s: number) => s === 503 || s === 500 || s === 502 || s === 504;
const moveOn = (r: Res) => r.timedOut || busy(r.status) || r.status === 429 || r.status === 404; // 다음 모델로 넘어갈 만한 경우

export async function geminiComplete(prompt: string, opts: CompleteOpts): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const models = [...new Set((opts.models && opts.models.length ? opts.models : [DEEP_MODEL(), FAST_MODEL()]).filter(Boolean))];
  const start = Date.now();
  const deadline = start + opts.timeoutMs;
  const tried: string[] = [];
  let last: Res | null = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const left = deadline - Date.now();
    if (left < 2500) break;
    // 모델 하나가 시간 예산을 다 쓰지 못하게 한 번에 기다리는 시간을 제한한다(마지막 모델은 남은 시간 전부)
    const cap = i < models.length - 1 && opts.attemptMs ? Math.min(opts.attemptMs, left) : left;
    const t0 = Date.now();
    const r = await tryModel(model, key, prompt, opts, cap);
    last = r;
    tried.push(`${model}:${r.timedOut ? "timeout" : r.status}(${Date.now() - t0}ms)`);
    if (r.ok) {
      const text = (r.json.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
      console.log(`gemini ok ${model} ${Date.now() - start}ms (시도: ${tried.join(", ")})`);
      return text;
    }
    if (!moveOn(r)) throw new Error(`gemini ${r.status} (${model}): ${String(r.json?.error?.message ?? "").slice(0, 160)}`);
    // 혼잡이면 아주 잠깐 쉬고 다음 모델로
    if (busy(r.status) && deadline - Date.now() > 4000) await sleep(600);
  }
  console.error(`gemini 실패 (시도: ${tried.join(", ")})`);
  if (!last || last.timedOut) throw new Error(`timeout: Gemini가 ${Math.round((Date.now() - start) / 1000)}초 안에 답하지 않음 (시도: ${tried.join(", ")})`);
  if (last.status === 429) throw new Error("rate_limited");
  throw new Error(`gemini ${last.status} (${tried.join(", ")}): ${String(last.json?.error?.message ?? "").slice(0, 140)}`);
}

// 여러 글을 한 번에 임베딩(의미 숫자)으로. 반환: 글마다 EMBED_DIM개 숫자
export async function geminiEmbed(texts: string[], timeoutMs: number): Promise<{ vectors: number[][]; model: string }> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const start = Date.now();
  const models = [...new Set([EMBED_MODEL(), EMBED_FALLBACK])];
  let last: Res | null = null;
  for (const model of models) {
    const left = timeoutMs - (Date.now() - start);
    if (left < 2000) break;
    const r = await post(`${BASE}${encodeURIComponent(model)}:batchEmbedContents`, key, {
      requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, outputDimensionality: EMBED_DIM })),
    }, left);
    last = r;
    if (r.ok && Array.isArray(r.json.embeddings)) {
      const vectors = r.json.embeddings.map((e: { values?: number[] }) => e.values ?? []);
      if (vectors.length === texts.length && vectors.every((v: number[]) => v.length > 0)) {
        console.log(`embed ok ${model} ${texts.length}편 ${Date.now() - start}ms`);
        return { vectors, model };
      }
    }
    if (!moveOn(r) && r.status !== 400) break; // 400은 모델이 다른 형식을 원할 수 있어 예비 모델로
  }
  if (!last || last.timedOut) throw new Error(`timeout: 임베딩이 ${Math.round((Date.now() - start) / 1000)}초 안에 오지 않음`);
  if (last.status === 429) throw new Error("rate_limited");
  throw new Error(`embed ${last.status}: ${String(last.json?.error?.message ?? "").slice(0, 160)}`);
}
