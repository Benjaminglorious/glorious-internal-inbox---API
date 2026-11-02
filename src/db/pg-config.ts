export type PostgresSslMode = "default" | "disable" | "relaxed";

/** DATABASE_URL wins over POSTGRES_URL. INBOX_DB=sqlite forces the local file. */
export function readPostgresUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.INBOX_DB || "").trim().toLowerCase() === "sqlite") return null;
  const raw = (env.DATABASE_URL || env.POSTGRES_URL || "").trim();
  if (!raw) return null;
  if (!/^postgres(ql)?:\/\//i.test(raw)) {
    throw new Error("DATABASE_URL / POSTGRES_URL 必須係 postgres:// 或 postgresql:// 連線字串");
  }
  return raw;
}

/**
 * Render internal hosts (dpg-… without a public domain) do not use TLS.
 * External Render URLs include render.com and need TLS. Local Postgres stays on the default.
 */
export function postgresSslMode(connectionString: string): PostgresSslMode {
  if (/[?&]sslmode=disable(?:&|$)/i.test(connectionString)) return "disable";
  if (/[?&]sslmode=(require|verify-ca|verify-full|no-verify)(?:&|$)/i.test(connectionString)) {
    return "relaxed";
  }
  if (/render\.com/i.test(connectionString)) return "relaxed";
  return "default";
}

export function sslOptionFromMode(
  mode: PostgresSslMode
): false | { rejectUnauthorized: false } | undefined {
  if (mode === "disable") return false;
  if (mode === "relaxed") return { rejectUnauthorized: false };
  return undefined;
}

export function looksLikeRenderPostgres(connectionString: string): boolean {
  return /render\.com/i.test(connectionString) || /@dpg-/i.test(connectionString) || /\/\/dpg-/i.test(connectionString);
}
