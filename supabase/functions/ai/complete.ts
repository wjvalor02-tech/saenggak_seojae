// AI 단일 진입점. 앱의 모든 AI 기능은 이것만 부른다. 제공자 교체 = 환경변수 AI_PROVIDER 한 줄.
import { geminiComplete } from "./providers/gemini.ts";
import { anthropicComplete } from "./providers/anthropic.ts";

export type CompleteOpts = { json?: boolean; timeoutMs: number; effort?: "low" | "medium" | "high"; maxTokens?: number };
export type Provider = "gemini" | "anthropic";

export const provider = (): Provider => (Deno.env.get("AI_PROVIDER") === "anthropic" ? "anthropic" : "gemini");

export async function complete(prompt: string, opts: CompleteOpts): Promise<string> {
  return provider() === "anthropic" ? anthropicComplete(prompt, opts) : geminiComplete(prompt, opts);
}

// 응답에서 {...}만 뽑아 파싱.
// budgetMs는 '요청 전체'의 시간 예산이다. 응답이 깨졌을 때만, 남은 시간이 충분하면 한 번 더 시도한다.
// (예전엔 시도마다 같은 제한을 줘서 재시도까지 하면 앱이 기다리는 시간보다 길어졌다)
export async function completeJSON<T>(
  prompt: string,
  validate: (j: unknown) => j is T,
  budgetMs = 25000,
  extra: Partial<CompleteOpts> = {},
): Promise<T> {
  const start = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budgetMs - (Date.now() - start);
    if (attempt > 0 && left < budgetMs * 0.45) break; // 남은 시간이 부족하면 재시도하지 않는다
    try {
      const raw = await complete(prompt, { json: true, timeoutMs: left, ...extra });
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("응답에 JSON이 없음");
      const j = JSON.parse(m[0]);
      if (validate(j)) return j;
      throw new Error("응답 형식이 맞지 않음");
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // 시간 초과·한도 초과·키 없음·모델 없음·혼잡(예비 모델까지 이미 시도함)은 다시 해도 소용없다
      if (/timeout|rate_limited|missing|gemini [45]\d\d|refusal/.test(msg)) break;
    }
  }
  throw lastErr;
}
