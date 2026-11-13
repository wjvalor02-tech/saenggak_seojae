// Gemini 어댑터(기본). AI_PROVIDER=gemini 일 때 사용.
import type { CompleteOpts } from "../complete.ts";

// 구현 시점 기준 Flash 계열 경량 모델. 최신 이름은 Google AI Studio 문서를 확인하고 AI_MODEL로 바꾼다.
const DEFAULT_MODEL = "gemini-2.5-flash";

export async function geminiComplete(prompt: string, opts: CompleteOpts): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const model = Deno.env.get("AI_MODEL") || DEFAULT_MODEL;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: opts.json ? { responseMimeType: "application/json" } : {},
      }),
    });
    if (r.status === 429) throw new Error("rate_limited");
    if (!r.ok) throw new Error("gemini " + r.status);
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  } finally {
    clearTimeout(t);
  }
}
