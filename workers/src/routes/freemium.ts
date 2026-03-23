import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN: string;
};

interface FreemiumRequestBody {
  email: string;
  source_page?: string;
}

const freemiumRoute = new Hono<{ Bindings: Bindings }>();

freemiumRoute.post("/", async (c) => {
  let body: FreemiumRequestBody;
  try {
    body = await c.req.json<FreemiumRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { email, source_page } = body;

  // Validate required fields
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return c.json({ error: "有効なメールアドレスが必要です" }, 400);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO leads (email, source_page, type)
       VALUES (?, ?, 'freemium')`
    )
      .bind(email.trim(), source_page ?? null)
      .run();

    return c.json({ success: true });
  } catch (err) {
    console.error("DB insert error (freemium):", err);
    return c.json({ error: "登録に失敗しました" }, 500);
  }
});

export default freemiumRoute;
