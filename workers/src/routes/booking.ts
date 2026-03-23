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
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return c.json({ error: "有効なメールアドレスが必要です" }, 400);
  }
  if (!date || typeof date !== "string") {
    return c.json({ error: "日付が必要です" }, 400);
  }
  if (!time || typeof time !== "string") {
    return c.json({ error: "時間が必要です" }, 400);
  }

  try {
    // Insert lead first
    const leadResult = await c.env.DB.prepare(
      `INSERT INTO leads (email, company, name, source_page, type)
       VALUES (?, ?, ?, ?, 'booking')`
    )
      .bind(
        email.trim(),
        company ?? null,
        name ?? null,
        source_page ?? null
      )
      .run();

    const leadId = leadResult.meta.last_row_id;

    // Insert booking
    const bookingResult = await c.env.DB.prepare(
      `INSERT INTO bookings (lead_id, date, time, name, email, company)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        leadId,
        date.trim(),
        time.trim(),
        name ?? null,
        email.trim(),
        company ?? null
      )
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
