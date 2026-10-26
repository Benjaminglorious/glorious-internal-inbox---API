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

const PORT = Number(process.env.PORT || 3001);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";

const app = express();

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

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
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use("/api/auth", authRouter);
app.use("/api", apiRouter);
app.use(pagesRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "伺服器錯誤" });
});

app.listen(PORT, () => {
  console.log(`glorious-internal-inbox 已啟動：http://localhost:${PORT}`);
});
