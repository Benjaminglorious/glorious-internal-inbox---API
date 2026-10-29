import "dotenv/config";
import express from "express";
import session from "express-session";
import path from "path";
import fs from "fs";

// Ensure DB schema exists before routes load queries
import "./db";

import { authRouter } from "./routes/auth";
import { apiRouter } from "./routes/api";
import { pagesRouter } from "./routes/pages";
import { whatsappWebhookRouter } from "./routes/webhooks";
import { isPushConfigured } from "./services/push";
import { ensureCompanyWhatsAppLine } from "./services/whatsapp";

ensureCompanyWhatsAppLine();

const PORT = Number(process.env.PORT || 3001);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";

const app = express();
const publicDir = path.join(process.cwd(), "public");

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/sw.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Service-Worker-Allowed", "/");
  res.type("application/javascript; charset=utf-8");
  res.sendFile(path.join(publicDir, "sw.js"));
});

app.get("/manifest.webmanifest", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.type("application/manifest+json; charset=utf-8");
  res.sendFile(path.join(publicDir, "manifest.webmanifest"));
});

app.use(express.static(publicDir));

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

// Prefer SQLite session store; fall back to MemoryStore for demo if package fails
let sessionStore: session.Store | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SQLiteStore = require("connect-sqlite3")(session);
  sessionStore = new SQLiteStore({
    db: "sessions.db",
    dir: dataDir,
  });
} catch (err) {
  console.warn("connect-sqlite3 不可用，改用 MemoryStore：", err);
}

app.use(
  session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use("/api/webhooks/whatsapp", whatsappWebhookRouter);
app.use("/api/auth", authRouter);
app.use("/api", apiRouter);
app.use(pagesRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "伺服器錯誤" });
});

app.listen(PORT, () => {
  console.log(`glorious-internal-inbox 已啟動：http://localhost:${PORT}`);
  console.log(
    isPushConfigured()
      ? "Web Push：已設定 VAPID"
      : "Web Push：未設定 VAPID（PWA 仍可安裝，關閉頁面後唔會推送）"
  );
});
