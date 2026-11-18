// Gemini 어댑터(기본). AI_PROVIDER=gemini 일 때 사용.
import type { CompleteOpts } from "../complete.ts";

// 2026-11 기준 Gemini의 안정판 Flash 모델. 2.5 계열은 예전에 쓰던 계정에만 열려 있어
// 새 키로는 호출이 실패한다. 바꾸려면 AI_MODEL 비밀값.
const DEFAULT_MODEL = "gemini-3.8-flash";
// 기본 모델이 혼잡(503)하거나 한도(429)·없음(404)일 때 차례로 시도할 예비 모델(쉼표로 여러 개).
// Flash-Lite는 더 가볍고 빨라 혼잡할 때 대신 쓰기 좋다. 바꾸려면 AI_FALLBACK_MODELS 비밀값.
const DEFAULT_FALLBACKS = "gemini-3.5-flash-lite";

type Res = { status: number; ok: boolean; json: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 응답 본문까지 다 받은 뒤 반환한다(시간 제한이 본문 읽기에도 걸리도록).
async function call(model: string, key: string, body: unknown, timeoutMs: number): Promise<Res> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs));
  const start = Date.now();
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, json };
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`timeout: Gemini(${model})가 ${Math.round((Date.now() - start) / 1000)}초 안에 답하지 않음`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// 모델 하나로 요청. 생각 깊이 설정을 모델이 모르면(400) 빼고 한 번 더.
async function tryModel(model: string, key: string, prompt: string, opts: CompleteOpts, deadline: number): Promise<Res> {
  const generationConfig: Record<string, unknown> = {};
  if (opts.json) generationConfig.responseMimeType = "application/json";
  if (opts.maxTokens) generationConfig.maxOutputTokens = opts.maxTokens;
  const base = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  let r = await call(model, key, { ...base, generationConfig: { ...generationConfig, ...(opts.effort ? { thinkingConfig: { thinkingLevel: opts.effort } } : {}) } }, deadline - Date.now());
  if (r.status === 400 && opts.effort && deadline - Date.now() > 2000) {
    console.warn(`${model}: thinkingLevel 거부됨, 빼고 다시:`, String(r.json?.error?.message ?? "").slice(0, 120));
    r = await call(model, key, { ...base, generationConfig }, deadline - Date.now());
  }
  return r;
}

const busy = (s: number) => s === 503 || s === 500 || s === 502 || s === 504; // 혼잡·일시 장애
const skipToNext = (s: number) => busy(s) || s === 429 || s === 404; // 예비 모델로 넘어갈 만한 오류

export async function geminiComplete(prompt: string, opts: CompleteOpts): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const primary = Deno.env.get("AI_MODEL") || DEFAULT_MODEL;
  const fallbacks = (Deno.env.get("AI_FALLBACK_MODELS") ?? DEFAULT_FALLBACKS).split(",").map((s) => s.trim()).filter((m) => m && m !== primary);
  const models = [primary, ...fallbacks];
  const start = Date.now();
  const deadline = start + opts.timeoutMs;
  const tried: string[] = [];
  let last: Res | null = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    // 혼잡하면 같은 모델로 잠깐 쉬었다가 한 번 더(기본 모델만). 시간이 모자라면 바로 다음 모델로.
    for (let attempt = 0; attempt < (i === 0 ? 2 : 1); attempt++) {
      if (deadline - Date.now() < 3000) break;
      const r = await tryModel(model, key, prompt, opts, deadline);
      last = r;
      tried.push(`${model}:${r.status}`);
      if (r.ok) {
        const text = (r.json.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
        console.log(`gemini ok ${model} ${Date.now() - start}ms (시도: ${tried.join(", ")})`);
        return text;
      }
      if (!skipToNext(r.status)) {
        // 키·요청 문제(400·401·403 등)는 다른 모델로 바꿔도 안 된다
        throw new Error(`gemini ${r.status} (${model}): ${String(r.json?.error?.message ?? "").slice(0, 160)}`);
      }
      if (busy(r.status) && attempt === 0 && i === 0 && deadline - Date.now() > 8000) await sleep(1500);
      else break;
    }
  }
  const st = last?.status ?? 0;
  console.error(`gemini 실패 (시도: ${tried.join(", ")})`);
  if (st === 429) throw new Error("rate_limited");
  if (!last) throw new Error(`timeout: Gemini가 시간 안에 답하지 않음`);
  throw new Error(`gemini ${st} (${tried.join(", ")}): ${String(last.json?.error?.message ?? "").slice(0, 140)}`);
}
