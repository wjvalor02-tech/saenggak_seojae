// Gemini 어댑터(기본). AI_PROVIDER=gemini 일 때 사용.
import type { CompleteOpts } from "../complete.ts";

// 2026-11 기준 Gemini의 안정판 Flash 모델. 2.5 계열은 예전에 쓰던 계정에만 열려 있어
// 새 키로는 호출이 실패한다(그러면 앱이 간단 규칙 분류로만 동작함). 바꾸려면 AI_MODEL 비밀값.
const DEFAULT_MODEL = "gemini-3.8-flash";

// 응답 본문까지 다 받은 뒤 반환한다(시간 제한이 본문 읽기에도 걸리도록).
// 제한을 넘기면 알아보기 쉬운 'timeout' 오류로 바꾼다(예전엔 'The signal has been aborted'로만 보였다).
async function call(model: string, key: string, body: unknown, timeoutMs: number): Promise<{ status: number; ok: boolean; json: any }> {
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

export async function geminiComplete(prompt: string, opts: CompleteOpts): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const model = Deno.env.get("AI_MODEL") || DEFAULT_MODEL;
  const generationConfig: Record<string, unknown> = {};
  if (opts.json) generationConfig.responseMimeType = "application/json";
  if (opts.maxTokens) generationConfig.maxOutputTokens = opts.maxTokens;
  const base = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

  // 분류 같은 짧은 작업은 생각 깊이를 낮춰 빠르게. 모델이 이 설정을 모르면(400) 빼고 한 번 더.
  const start = Date.now();
  let r = await call(model, key, { ...base, generationConfig: { ...generationConfig, ...(opts.effort ? { thinkingConfig: { thinkingLevel: opts.effort } } : {}) } }, opts.timeoutMs);
  if (r.status === 400 && opts.effort) {
    console.warn("thinkingLevel 거부됨, 빼고 다시:", String(r.json?.error?.message ?? "").slice(0, 160));
    r = await call(model, key, { ...base, generationConfig }, opts.timeoutMs - (Date.now() - start));
  }

  if (r.status === 429) throw new Error("rate_limited");
  if (!r.ok) throw new Error(`gemini ${r.status} (${model}): ${String(r.json?.error?.message ?? "").slice(0, 160)}`);
  console.log(`gemini ${model} ${Date.now() - start}ms`);
  return (r.json.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
}
