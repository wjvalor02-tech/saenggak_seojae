// Gemini 어댑터(기본). AI_PROVIDER=gemini 일 때 사용.
import type { CompleteOpts } from "../complete.ts";

// 2026-11 기준 Gemini의 안정판 Flash 모델. 2.5 계열은 예전에 쓰던 계정에만 열려 있어
// 새 키로는 호출이 실패한다(그러면 앱이 간단 규칙 분류로만 동작함). 바꾸려면 AI_MODEL 비밀값.
const DEFAULT_MODEL = "gemini-3.8-flash";

async function call(model: string, key: string, body: unknown, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
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
  let r = await call(model, key, { ...base, generationConfig: { ...generationConfig, ...(opts.effort ? { thinkingConfig: { thinkingLevel: opts.effort } } : {}) } }, opts.timeoutMs);
  if (r.status === 400 && opts.effort) r = await call(model, key, { ...base, generationConfig }, opts.timeoutMs);

  if (r.status === 429) throw new Error("rate_limited");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`gemini ${r.status} (${model}): ${String(j?.error?.message ?? "").slice(0, 160)}`);
  }
  const j = await r.json();
  return (j.candidates?.[0]?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
}
