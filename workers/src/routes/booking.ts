import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN: string;
};

interface BookingRequestBody {
  date: string;
  time: string;
  name?: string;
  email: string;
  company?: string;
  source_page?: string;
}

// --- Validation ---
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}$/;

const bookingRoute = new Hono<{ Bindings: Bindings }>();

bookingRoute.post("/", async (c) => {
  let body: BookingRequestBody;
  try {
    body = await c.req.json<BookingRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { date, time, name, email, company, source_page } = body;

  // Validate required fields
  if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    return c.json({ error: "有効なメールアドレスが必要です" }, 400);
  }
  if (!date || typeof date !== "string" || !DATE_REGEX.test(date)) {
    return c.json({ error: "日付はYYYY-MM-DD形式で入力してください" }, 400);
  }
  if (!time || typeof time !== "string" || !TIME_REGEX.test(time)) {
    return c.json({ error: "時間はHH:MM形式で入力してください" }, 400);
  }

  // Reject past dates
  const bookingDate = new Date(date + "T" + time + ":00+09:00"); // JST
  if (bookingDate < new Date()) {
    return c.json({ error: "過去の日時は指定できません" }, 400);
  }

  // Input length limits
  const trimmedEmail = email.trim().slice(0, 254);
  const trimmedName = name ? String(name).slice(0, 100) : null;
  const trimmedCompany = company ? String(company).slice(0, 200) : null;
  const trimmedSourcePage = source_page ? String(source_page).slice(0, 20) : null;

  try {
    // Use D1 batch for atomic insert (lead + booking)
    const leadStmt = c.env.DB.prepare(
      `INSERT INTO leads (email, company, name, source_page, type)
       VALUES (?, ?, ?, ?, 'booking')`
    ).bind(trimmedEmail, trimmedCompany, trimmedName, trimmedSourcePage);

    const leadResult = await leadStmt.run();
    const leadId = leadResult.meta.last_row_id;

    const bookingResult = await c.env.DB.prepare(
      `INSERT INTO bookings (lead_id, date, time, name, email, company)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(leadId, date.trim(), time.trim(), trimmedName, trimmedEmail, trimmedCompany)
      .run();

    return c.json({
      success: true,
      id: bookingResult.meta.last_row_id,
    });
  } catch (err) {
    console.error("DB insert error (booking):", err);
    return c.json({ error: "予約の保存に失敗しました" }, 500);
  }
});

export default bookingRoute;
