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

// --- Validation ---
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    return c.json({ error: "有効なメールアドレスが必要です" }, 400);
  }

  // Input length limits
  const trimmedEmail = email.trim().slice(0, 254);
  const trimmedCompany = company ? String(company).slice(0, 200) : null;
  const trimmedName = name ? String(name).slice(0, 100) : null;
  const trimmedPhone = phone ? String(phone).slice(0, 20) : null;
  const trimmedSize = size ? String(size).slice(0, 50) : null;
  const trimmedMessage = message ? String(message).slice(0, 2000) : null;
  const trimmedSourcePage = source_page ? String(source_page).slice(0, 20) : null;

  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO leads (email, company, name, phone, size, message, source_page, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'contact')`
    )
      .bind(
        trimmedEmail,
        trimmedCompany,
        trimmedName,
        trimmedPhone,
        trimmedSize,
        trimmedMessage,
        trimmedSourcePage
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
