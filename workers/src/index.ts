import { Hono } from "hono";
import { cors } from "hono/cors";
import chatRoute from "./routes/chat";
import contactRoute from "./routes/contact";
import bookingRoute from "./routes/booking";
import freemiumRoute from "./routes/freemium";
import abRoute from "./routes/ab";

type Bindings = {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// --- CORS Middleware ---
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.ALLOWED_ORIGIN || "";
      const allowedOrigins = [
        allowed,
        "http://localhost:3000",
        "http://localhost:8787",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
      ].filter(Boolean);

      if (!origin || allowedOrigins.includes(origin)) {
        return origin || "*";
      }
      return "";
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    maxAge: 86400,
  })
);

// --- Routes ---
app.route("/api/chat", chatRoute);
app.route("/api/contact", contactRoute);
app.route("/api/booking", bookingRoute);
app.route("/api/freemium", freemiumRoute);
app.route("/api/ab", abRoute);

// --- Health Check ---
app.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "rakuda-costcut-api",
    version: "1.0.0",
  });
});

// --- 404 ---
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});

// --- Error Handler ---
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal Server Error" }, 500);
});

export default app;
