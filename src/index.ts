import "dotenv/config";
import express from "express";
import session from "express-session";
import path from "path";
import fs from "fs";

// Schema migrate runs when the db module loads. Postgres when DATABASE_URL / POSTGRES_URL is set.
import { getPostgresSslMode, getPostgresUrl, usingPostgres } from "./db";
import { sslOptionFromMode } from "./db/pg-config";
import { syncStaffOnBoot } from "./db/seed";

import { authRouter } from "./routes/auth";
import { apiRouter } from "./routes/api";
import { pagesRouter } from "./routes/pages";
import {
  metaWebhookRouter,
  siteCommentWebhookRouter,
  whatsappWebhookRouter,
} from "./routes/webhooks";
import { startCompanyEmailPoller } from "./services/email-poll";
import { isPushConfigured } from "./services/push";

syncStaffOnBoot();

const PORT = Number(process.env.PORT || 3001);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";

const app = express();
const publicDir = path.join(process.cwd(), "public");

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const url = req.originalUrl || req.url || "";
  const mediaUpload = req.method === "POST" && /\/comments\/\d+\/media-replies(?:\?|$)/.test(url);
  if (mediaUpload) {
    return express.json({ limit: "28mb" })(req, res, next);
  }
  return express.json({
    limit: "100kb",
    verify: (innerReq, _res, buf) => {
      // Meta X-Hub-Signature-256 需要原始 bytes；有 META_APP_SECRET 時先用。
      (innerReq as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  })(req, res, next);
});

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

// Postgres sessions follow the inbox database. SQLite sessions stay beside the local file.
let sessionStore: session.Store | undefined;
const postgresUrl = getPostgresUrl();
if (postgresUrl) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg") as typeof import("pg");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PgStore = require("connect-pg-simple")(session);
    const sslMode = getPostgresSslMode();
    sessionStore = new PgStore({
      pool: new Pool({
        connectionString: postgresUrl,
        max: 2,
        application_name: "glorious-internal-inbox-sessions",
        ssl: sslMode ? sslOptionFromMode(sslMode) : undefined,
      }),
      createTableIfMissing: true,
    });
  } catch (err) {
    console.warn("Postgres session store 不可用，改用 MemoryStore：", err);
  }
} else {
  fs.mkdirSync(dataDir, { recursive: true });
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
app.use("/api/webhooks/site-comment", siteCommentWebhookRouter);
app.use("/api/webhooks/meta", metaWebhookRouter);
app.use("/api/auth", authRouter);
app.use("/api", apiRouter);
app.use(pagesRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "伺服器錯誤" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`glorious-internal-inbox 已啟動：http://0.0.0.0:${PORT}`);
  console.log(usingPostgres ? "[db] PostgreSQL" : "[db] SQLite");
  console.log(
    isPushConfigured()
      ? "Web Push：已設定 VAPID"
      : "Web Push：未設定 VAPID（PWA 仍可安裝，關閉頁面後唔會推送）"
  );
  startCompanyEmailPoller();
});
