import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN: string;
};

interface ContactRequestBody {
  email: string;
  company?: string;
  name?: string;
  phone?: string;
  size?: string;
  message?: string;
  source_page?: string;
}

const contactRoute = new Hono<{ Bindings: Bindings }>();

contactRoute.post("/", async (c) => {
  let body: ContactRequestBody;
  try {
    body = await c.req.json<ContactRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { email, company, name, phone, size, message, source_page } = body;

  // Validate required fields
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return c.json({ error: "有効なメールアドレスが必要です" }, 400);
  }

  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO leads (email, company, name, phone, size, message, source_page, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'contact')`
    )
      .bind(
        email.trim(),
        company ?? null,
        name ?? null,
        phone ?? null,
        size ?? null,
        message ?? null,
        source_page ?? null
      )
      .run();

    return c.json({
      success: true,
      id: result.meta.last_row_id,
    });
  } catch (err) {
    console.error("DB insert error (contact):", err);
    return c.json({ error: "データの保存に失敗しました" }, 500);
  }
});

export default contactRoute;
