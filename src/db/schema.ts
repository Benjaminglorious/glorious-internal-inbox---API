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
  wa_from_phone TEXT,
  wa_to_phone TEXT,
  entry_path TEXT CHECK (entry_path IS NULL OR entry_path IN ('28car_board', '28car_wa_link')),
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
  delivery_status TEXT NOT NULL DEFAULT 'stub' CHECK (delivery_status IN ('stored', 'stub', 'failed', 'sent')),
  delivery_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (direction = 'outbound' AND staff_id IS NOT NULL) OR
    (direction = 'inbound')
  )
);

CREATE INDEX IF NOT EXISTS idx_comment_replies_comment ON comment_replies(comment_id, id);

CREATE TABLE IF NOT EXISTS car_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT '28car' CHECK (source = '28car'),
  stock_id TEXT NOT NULL,
  vid TEXT,
  account_username TEXT NOT NULL,
  title TEXT NOT NULL,
  price_hkd INTEGER,
  price_text TEXT,
  comment_count INTEGER,
  listing_updated_at TEXT,
  public_url TEXT,
  dealer_url TEXT,
  blurb TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sync_origin TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, stock_id)
);

CREATE INDEX IF NOT EXISTS idx_car_listings_account ON car_listings(account_username, active);

CREATE TABLE IF NOT EXISTS car_listing_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  is_seller INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT,
  inbox_comment_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (stock_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_car_listing_messages_stock ON car_listing_messages(stock_id, id);

CREATE TABLE IF NOT EXISTS car_reply_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  stock_id TEXT,
  vid TEXT,
  account_username TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'posting', 'sent', 'failed')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_car_reply_queue_status ON car_reply_queue(status, id);

CREATE TABLE IF NOT EXISTS car_sync_state (
  source TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_mode TEXT,
  last_error TEXT,
  listings_upserted INTEGER NOT NULL DEFAULT 0,
  comments_upserted INTEGER NOT NULL DEFAULT 0,
  network_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS car_egress_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_lease_id TEXT,
  last_operation TEXT,
  updated_at TEXT
);
`;
