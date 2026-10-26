export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('28car', 'glorious_web', 'facebook', 'whatsapp')),
  external_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  vehicle_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  assignee_staff_id INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
CREATE INDEX IF NOT EXISTS idx_comments_source ON comments(source);
CREATE INDEX IF NOT EXISTS idx_comments_assignee ON comments(assignee_staff_id);

CREATE TABLE IF NOT EXISTS whatsapp_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_e164 TEXT NOT NULL UNIQUE,
  display_label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('company', 'staff')),
  staff_id INTEGER REFERENCES staff(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'company' AND staff_id IS NULL) OR
    (kind = 'staff' AND staff_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_lines_staff ON whatsapp_lines(staff_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_lines_one_active_staff
  ON whatsapp_lines(staff_id)
  WHERE kind = 'staff' AND is_active = 1;
`;
