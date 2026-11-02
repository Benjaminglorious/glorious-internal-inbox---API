/** UTC timestamp text matching SQLite datetime('now'): YYYY-MM-DD HH:MM:SS. */
export const PG_NOW_SQL =
  "(to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'))";

/**
 * Turn SQLite-flavoured SQL into PostgreSQL.
 * `?` placeholders become `$1…` outside string literals.
 * `datetime('now')` becomes a UTC text timestamp.
 */
export function translateSql(sql: string): string {
  const withNow = sql.replaceAll("datetime('now')", PG_NOW_SQL);
  let out = "";
  let n = 0;
  for (let i = 0; i < withNow.length; i++) {
    const c = withNow[i];
    if (c === "'") {
      out += c;
      i++;
      while (i < withNow.length) {
        const ch = withNow[i];
        out += ch;
        if (ch === "'") {
          if (withNow[i + 1] === "'") {
            out += withNow[i + 1];
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "?") {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += c;
  }
  return out;
}

/** INSERT … RETURNING id so the sync driver can fill lastInsertRowid. */
export function insertReturningId(sql: string): string {
  const trimmed = sql.trim();
  if (!/^insert\s+/i.test(trimmed)) return sql;
  if (/\breturning\b/i.test(trimmed)) return sql;
  if (/^insert\s+into\s+car_sync_state\b/i.test(trimmed)) return sql;
  return `${trimmed.replace(/;\s*$/, "")} RETURNING id`;
}
