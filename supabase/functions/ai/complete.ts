// AI 단일 진입점. 앱의 모든 AI 기능은 이것만 부른다. 제공자 교체 = 환경변수 AI_PROVIDER 한 줄.
import { geminiComplete } from "./providers/gemini.ts";
import { anthropicComplete } from "./providers/anthropic.ts";

export type CompleteOpts = { json?: boolean; timeoutMs: number; effort?: "low" | "medium" | "high"; maxTokens?: number };
export type Provider = "gemini" | "anthropic";

export const provider = (): Provider => (Deno.env.get("AI_PROVIDER") === "anthropic" ? "anthropic" : "gemini");

export async function complete(prompt: string, opts: CompleteOpts): Promise<string> {
  return provider() === "anthropic" ? anthropicComplete(prompt, opts) : geminiComplete(prompt, opts);
}

// 응답에서 {...}만 뽑아 파싱. 검증 실패 시 1회 재시도.
export async function completeJSON<T>(
  prompt: string,
  validate: (j: unknown) => j is T,
  timeoutMs = 18000,
  extra: Partial<CompleteOpts> = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await complete(prompt, { json: true, timeoutMs, ...extra });
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no json");
      const j = JSON.parse(m[0]);
      if (validate(j)) return j;
      throw new Error("schema");
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // 한도 초과·키 없음·모델 없음은 다시 해도 소용없다
      if (/rate_limited|missing|gemini 4\d\d|refusal/.test(msg)) break;
    }
  }
  throw lastErr;
}
