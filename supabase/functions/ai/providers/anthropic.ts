// Claude 어댑터. AI_PROVIDER=anthropic 일 때 사용.
import Anthropic from "npm:@anthropic-ai/sdk";
import type { CompleteOpts } from "../complete.ts";

// 설계 문서: Claude로 바꿀 때는 Haiku/Sonnet 계열 경량 모델. 바꾸려면 AI_MODEL 환경변수.
const DEFAULT_MODEL = "claude-haiku-5-5";

let client: Anthropic | null = null;

export async function anthropicComplete(prompt: string, opts: CompleteOpts): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
  client ??= new Anthropic({ apiKey, maxRetries: 1 });
  const response = await client.messages.create({
    model: Deno.env.get("AI_MODEL") || DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 4000,
    // 분류는 low, 주간 검토·글감은 medium
    output_config: { effort: opts.effort ?? "low" },
    system: opts.json ? "응답은 설명 없이 JSON 객체 하나만 출력한다." : undefined,
    messages: [{ role: "user", content: prompt }],
  }, { timeout: opts.timeoutMs });
  if (response.stop_reason === "refusal") throw new Error("refusal");
  return response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}
