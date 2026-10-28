/** comments 表欄位。新庫同啟動遷移共用，避免 CHECK 漂移。 */
export const COMMENTS_CREATE_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('28car', 'glorious_web', 'facebook', 'instagram', 'whatsapp')),
  external_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  vehicle_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  assignee_staff_id INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  intake_kind TEXT NOT NULL DEFAULT 'site_comment' CHECK (intake_kind IN ('site_comment', 'whatsapp_click')),
  origin_site TEXT CHECK (origin_site IS NULL OR origin_site IN ('28car', 'glorious_web', 'facebook', 'instagram')),
  UNIQUE (source, external_id),
  CHECK (
    (
      source IN ('28car', 'glorious_web', 'facebook', 'instagram')
      AND intake_kind = 'site_comment'
      AND origin_site IS NULL
    )
    OR (
      source = 'whatsapp'
      AND intake_kind = 'whatsapp_click'
    )
  )
`;

/** 舊庫都有呢啲欄，可以喺遷移之前建立。 */
export const COMMENT_BASE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
CREATE INDEX IF NOT EXISTS idx_comments_source ON comments(source);
CREATE INDEX IF NOT EXISTS idx_comments_assignee ON comments(assignee_staff_id);
`;

/** 新欄位索引。必須等 comments 遷移完先至跑，否則舊庫會話冇 intake_kind。 */
export const COMMENT_INDEX_SQL = `
${COMMENT_BASE_INDEX_SQL}
CREATE INDEX IF NOT EXISTS idx_comments_intake ON comments(intake_kind);
CREATE INDEX IF NOT EXISTS idx_comments_origin ON comments(origin_site);
`;

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
  ${COMMENTS_CREATE_COLUMNS}
);

${COMMENT_BASE_INDEX_SQL}

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

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_staff ON push_subscriptions(staff_id);

CREATE TABLE IF NOT EXISTS comment_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id),
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  body TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'stub' CHECK (delivery_status IN ('stored', 'stub', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (direction = 'outbound' AND staff_id IS NOT NULL) OR
    (direction = 'inbound')
  )
);

CREATE INDEX IF NOT EXISTS idx_comment_replies_comment ON comment_replies(comment_id, id);
`;
