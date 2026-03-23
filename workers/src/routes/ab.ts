import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

type Bindings = {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN: string;
};

// --- Types ---
interface AbEventRequestBody {
  visitor_id: string;
  page: string;
  event: string;
  metadata?: string;
}

interface FunnelRow {
  page: string;
  event: string;
  cnt: number;
}

// --- Constants ---
const PAGES = ["p2", "p3", "p6", "p7"];
const COOKIE_NAME = "rakuda_ab";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

const abRoute = new Hono<{ Bindings: Bindings }>();

// POST /api/ab/event - Record an A/B test event
abRoute.post("/event", async (c) => {
  let body: AbEventRequestBody;
  try {
    body = await c.req.json<AbEventRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { visitor_id, page, event, metadata } = body;

  if (!visitor_id || typeof visitor_id !== "string" || visitor_id.length > 64) {
    return c.json({ error: "visitor_id is required (max 64 chars)" }, 400);
  }
  if (!page || typeof page !== "string" || page.length > 20) {
    return c.json({ error: "page is required (max 20 chars)" }, 400);
  }
  if (!event || typeof event !== "string" || event.length > 50) {
    return c.json({ error: "event is required (max 50 chars)" }, 400);
  }

  // Metadata length limit (1KB max)
  const trimmedMetadata = metadata ? String(metadata).slice(0, 1024) : null;

  try {
    await c.env.DB.prepare(
      `INSERT INTO ab_events (visitor_id, page, event, metadata)
       VALUES (?, ?, ?, ?)`
    )
      .bind(
        visitor_id.trim(),
        page.trim(),
        event.trim(),
        trimmedMetadata
      )
      .run();

    return c.json({ success: true });
  } catch (err) {
    console.error("DB insert error (ab_event):", err);
    return c.json({ error: "イベントの記録に失敗しました" }, 500);
  }
});

// GET /api/ab/assign - Assign a page variant
abRoute.get("/assign", async (c) => {
  // Check for existing cookie
  const existingPage = getCookie(c, COOKIE_NAME);

  if (existingPage && PAGES.includes(existingPage)) {
    return c.json({ page: existingPage });
  }

  // Randomly assign a page with equal weight
  const assignedPage = PAGES[Math.floor(Math.random() * PAGES.length)];

  // Set cookie with 30-day expiry
  setCookie(c, COOKIE_NAME, assignedPage, {
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    httpOnly: false, // Frontend needs to read it
    sameSite: "Lax",
  });

  return c.json({ page: assignedPage });
});

// GET /api/ab/stats - Return per-page conversion funnel stats
abRoute.get("/stats", async (c) => {
  const FUNNEL_EVENTS = [
    "view",
    "scroll_50",
    "cta_click",
    "chat_start",
    "form_open",
    "form_submit",
  ];

  try {
    const result = await c.env.DB.prepare(
      `SELECT page, event, COUNT(*) as cnt
       FROM ab_events
       WHERE event IN (?, ?, ?, ?, ?, ?)
       GROUP BY page, event
       ORDER BY page, event`
    )
      .bind(...FUNNEL_EVENTS)
      .all<FunnelRow>();

    // Build structured response
    const stats: Record<string, Record<string, number>> = {};

    for (const page of PAGES) {
      stats[page] = {};
      for (const event of FUNNEL_EVENTS) {
        stats[page][event] = 0;
      }
    }

    if (result.results) {
      for (const row of result.results) {
        if (stats[row.page]) {
          stats[row.page][row.event] = row.cnt;
        }
      }
    }

    return c.json({ stats });
  } catch (err) {
    console.error("DB query error (ab_stats):", err);
    return c.json({ error: "統計の取得に失敗しました" }, 500);
  }
});

export default abRoute;
