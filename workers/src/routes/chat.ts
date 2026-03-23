import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN: string;
};

// --- Rate Limiter ---
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 3;

function cleanupRateLimitMap(): void {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitMap.entries()) {
    const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) {
      rateLimitMap.delete(key);
    } else {
      rateLimitMap.set(key, valid);
    }
  }
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();

  // Periodic cleanup (every 100 checks)
  if (Math.random() < 0.01) {
    cleanupRateLimitMap();
  }

  const timestamps = rateLimitMap.get(ip) ?? [];
  const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (valid.length >= RATE_LIMIT_MAX) {
    return true;
  }

  valid.push(now);
  rateLimitMap.set(ip, valid);
  return false;
}

// --- Input Sanitization ---
function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, "");
}

function sanitizeMessage(content: string): string {
  const stripped = stripHtml(content);
  return stripped.slice(0, 500);
}

// --- System Prompts ---
const BASE_SYSTEM =
  "日本語で回答してください。回答は簡潔に、200文字以内を目安にしてください。RAKUDAは企業のコスト削減を支援するAIプラットフォームです。";

const PAGE_PROMPTS: Record<string, string> = {
  p2: `あなたはRAKUDA COSTCUTのコスト削減コンサルタントです。企業のコスト構造をヒアリングし、課題を特定し、具体的な削減提案を行います。まず業種と規模を確認してから分析を始めてください。\n\n${BASE_SYSTEM}`,
  p3: `あなたはRAKUDA COSTCUTの診断アドバイザーです。ユーザーのコスト体質診断結果を踏まえて、より深い分析とアドバイスを提供します。診断スコアや業界比較を参考に具体的な改善策を提案してください。\n\n${BASE_SYSTEM}`,
  p6: `あなたはRAKUDA COSTCUTのExcel業務改善アドバイザーです。企業のExcelベースのコスト管理の課題を聞き出し、自動化・効率化の提案を行います。\n\n${BASE_SYSTEM}`,
  p7: `あなたはRAKUDA COSTCUTのアシスタントです。簡潔にFAQに回答し、成果報酬型サービスの仕組みを分かりやすく説明してください。専門用語は避け、親しみやすい口調で対応してください。\n\n${BASE_SYSTEM}`,
  p8: `あなたはRAKUDA COSTCUTの戦略コンサルタントです。コンサルティングファームと同等の分析力をAIで提供するサービスの専門家として、企業の課題を構造的に分析し、戦略提案から実行支援・業務自動化まで一気通貫で支援できることを説明してください。フレームワーク（3C、バリューチェーン、コスト構造分析等）を活用した回答を心がけてください。\n\n${BASE_SYSTEM}`,
};

// --- Types ---
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  page: string;
}

// --- Route ---
const chatRoute = new Hono<{ Bindings: Bindings }>();

chatRoute.post("/", async (c) => {
  // Rate limiting
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for") ??
    "unknown";

  if (isRateLimited(ip)) {
    return c.json(
      { error: "レート制限を超えました。1分後に再度お試しください。" },
      429
    );
  }

  // Parse and validate body
  let body: ChatRequestBody;
  try {
    body = await c.req.json<ChatRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { messages, page } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "messages is required and must be a non-empty array" }, 400);
  }

  // Validate page
  const systemPrompt = PAGE_PROMPTS[page] ?? PAGE_PROMPTS["p7"];

  // Sanitize messages: limit to last 20, strip HTML, truncate
  const sanitizedMessages = messages.slice(-20).map((msg) => ({
    role: msg.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: sanitizeMessage(msg.content),
  }));

  // Call Anthropic API with streaming
  const anthropicResponse = await fetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPrompt,
        messages: sanitizedMessages,
        stream: true,
      }),
    }
  );

  if (!anthropicResponse.ok) {
    const errText = await anthropicResponse.text();
    console.error("Anthropic API error:", anthropicResponse.status, errText);
    return c.json({ error: "AI APIエラーが発生しました" }, 502);
  }

  // Stream SSE response
  const responseBody = anthropicResponse.body;
  if (!responseBody) {
    return c.json({ error: "Empty response from AI API" }, 502);
  }

  return new Response(responseBody, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": c.env.ALLOWED_ORIGIN || "*",
    },
  });
});

export default chatRoute;
