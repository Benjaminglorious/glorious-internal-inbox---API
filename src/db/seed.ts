import "dotenv/config";
import path from "path";
import { db, getDbPath } from "./index";
import { hashPassword } from "../auth/passwords";
import { autoAssignUnassigned } from "../services/assign";
import { notifyNewComment } from "../services/push";
import { createStaffReply } from "../services/replies";
import { ensureCompanyWhatsAppLine } from "../services/whatsapp";
import type { CommentSource, IntakeKind, OriginSite } from "../types";

/** Default demo password — MUST be changed in production. */
export const DEMO_PASSWORD = "Glorious2026!";

/**
 * 可登入：兩位管理員 + 兩位在職同事。其餘種子同事收藏（active=0），保留列但登入唔到。
 * 在職帳號次序係 eddie → wing → jason → tony，同自動派單優先名單一致。
 * 只影響全新資料庫嘅 staff.id；已有生產 id 靠 assign.ts 嘅 username 次序。
 */
export const SEED_STAFF: Array<{
  username: string;
  display_name: string;
  is_admin: number;
  active: number;
}> = [
  { username: "eddie", display_name: "Eddie Lau", is_admin: 1, active: 1 },
  { username: "wing", display_name: "Wing Cheng", is_admin: 0, active: 1 },
  { username: "jason", display_name: "Jason Cheng", is_admin: 0, active: 1 },
  { username: "tony", display_name: "Tony Chan", is_admin: 1, active: 1 },
  { username: "kaixin", display_name: "張嘉欣", is_admin: 0, active: 0 },
  { username: "ming", display_name: "王明軒", is_admin: 0, active: 0 },
  { username: "mei", display_name: "陳美玲", is_admin: 0, active: 0 },
  { username: "ho", display_name: "何志豪", is_admin: 0, active: 0 },
  { username: "yan", display_name: "林雅雯", is_admin: 0, active: 0 },
  { username: "chun", display_name: "黃俊傑", is_admin: 0, active: 0 },
  { username: "sze", display_name: "鄭詩敏", is_admin: 0, active: 0 },
  { username: "kit", display_name: "吳家傑", is_admin: 0, active: 0 },
  { username: "yuki", display_name: "趙雪兒", is_admin: 0, active: 0 },
];

interface DemoComment {
  source: CommentSource;
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref: string | null;
  status?: "open" | "in_progress" | "done";
  /** 只有 WhatsApp 先至用。網站／IG 留言會強制係 site_comment、origin 空。 */
  origin_site?: OriginSite | null;
}

const COMMENTS: DemoComment[] = [
  {
    source: "28car",
    external_id: "28c-1001",
    author_name: "阿強",
    body: "Alphard 2019 還可以議價嗎？想週末去葵涌陳列室睇車。",
    vehicle_ref: "Alphard 2019",
  },
  {
    source: "28car",
    external_id: "28c-1002",
    author_name: "Miss Chan",
    body: "Vellfire 有冇現貨？想了解分期詳情。",
    vehicle_ref: "Vellfire",
  },
  {
    source: "28car",
    external_id: "28c-1003",
    author_name: "David",
    body: "Toyota Noah 里程係咪真？可唔可以安排驗車？",
    vehicle_ref: "Toyota Noah",
  },
  {
    source: "28car",
    external_id: "28c-1004",
    author_name: "阿雯",
    body: "Hiace 客貨車有冇白色？預算 20 萬左右。",
    vehicle_ref: "Hiace",
    status: "in_progress",
  },
  {
    source: "28car",
    external_id: "28c-1005",
    author_name: "Ken",
    body: "想問 Prius 混能稅同保險大概幾多？",
    vehicle_ref: "Prius",
  },
  {
    source: "28car",
    external_id: "28c-1006",
    author_name: "Mrs. Wong",
    body: "Lexus NX 有冇低里數貨？謝謝。",
    vehicle_ref: "Lexus NX",
    status: "done",
  },
  {
    source: "glorious_web",
    external_id: "gw-2001",
    author_name: "訪客",
    body: "想預約星期六參觀葵涌陳列室睇 Alphard。",
    vehicle_ref: "Alphard",
  },
  {
    source: "glorious_web",
    external_id: "gw-2002",
    author_name: "陳先生",
    body: "請問日本拍賣代購流程同時間大概幾耐？",
    vehicle_ref: null,
  },
  {
    source: "glorious_web",
    external_id: "gw-2003",
    author_name: "Tracy",
    body: "官網有寫保養計劃，想了解詳情同價錢。",
    vehicle_ref: null,
    status: "in_progress",
  },
  {
    source: "glorious_web",
    external_id: "gw-2004",
    author_name: "Jason",
    body: "有冇 RAV4 混合動力？想 mid-size SUV。",
    vehicle_ref: "RAV4",
  },
  {
    source: "glorious_web",
    external_id: "gw-2005",
    author_name: "小美",
    body: "聯絡表格已填，請回電 9xxx-xxxx，方便下午。",
    vehicle_ref: null,
  },
  {
    source: "glorious_web",
    external_id: "gw-2006",
    author_name: "Andy",
    body: "想換車：現有 Camry 2016 可唔可以 trade-in？",
    vehicle_ref: "Camry 2016",
  },
  {
    source: "facebook",
    external_id: "fb-3001",
    author_name: "FB用戶·阿華",
    body: "帖文入面架黑色 Alphard 仲喺度嗎？PM 請回。",
    vehicle_ref: "Alphard 黑色",
  },
  {
    source: "facebook",
    external_id: "fb-3002",
    author_name: "FB用戶·Cindy",
    body: "幾時有下一次新車到港？想跟進。",
    vehicle_ref: null,
  },
  {
    source: "facebook",
    external_id: "fb-3003",
    author_name: "FB用戶·Louis",
    body: "可以 WhatsApp 聯絡嗎？留言好耐未見回覆。",
    vehicle_ref: null,
    status: "in_progress",
  },
  {
    source: "facebook",
    external_id: "fb-3004",
    author_name: "FB用戶·May",
    body: "廣告入面 Voxy 價錢包唔包稅？",
    vehicle_ref: "Voxy",
  },
  {
    source: "facebook",
    external_id: "fb-3005",
    author_name: "FB用戶·Tommy",
    body: "讚好咗專頁，想問有冇員工優惠？朋友介紹。",
    vehicle_ref: null,
  },
  {
    source: "facebook",
    external_id: "fb-3006",
    author_name: "FB用戶·Grace",
    body: "想睇下二手 MPV 清單，有連結嗎？",
    vehicle_ref: "MPV",
  },
  {
    source: "28car",
    external_id: "28c-1007",
    author_name: "Peter",
    body: "Esquire 七人車有冇自動泊車版本？",
    vehicle_ref: "Esquire",
  },
  {
    source: "glorious_web",
    external_id: "gw-2007",
    author_name: "梁小姐",
    body: "想約平日晚上去陳列室，可以嗎？",
    vehicle_ref: null,
  },
  {
    source: "whatsapp",
    external_id: "wa-direct-4001",
    author_name: "周先生",
    body: "我直接打去公司 WhatsApp 總機，冇經過 28car、官網、Facebook 或者 Instagram。想約星期六睇 Alphard。",
    vehicle_ref: "Alphard",
  },
  {
    source: "whatsapp",
    external_id: "wa-28car-4002",
    author_name: "陳生",
    body: "我喺 28car 車輛頁撳咗 WhatsApp 先至聯絡你哋，想問 Vellfire 有冇現貨。呢則唔係 28car 網站留言。",
    vehicle_ref: "Vellfire",
    origin_site: "28car",
  },
  {
    source: "whatsapp",
    external_id: "wa-gw-4003",
    author_name: "何太",
    body: "我喺東榮官網撳咗 WhatsApp 連結。想問日本拍賣代購，唔係官網表格留言。",
    vehicle_ref: null,
    origin_site: "glorious_web",
  },
  {
    source: "whatsapp",
    external_id: "wa-fb-4004",
    author_name: "Lucy",
    body: "Facebook 廣告入面撳咗 WhatsApp。想問 Voxy 包唔包稅。唔係專頁留言。",
    vehicle_ref: "Voxy",
    origin_site: "facebook",
  },
  {
    source: "instagram",
    external_id: "ig-5001",
    author_name: "IG用戶·阿偉",
    body: "我喺東榮 Instagram 帖文下面留言，想問黑色 Alphard 仲喺唔喺度。呢則唔係官網表格，亦唔係 WhatsApp。",
    vehicle_ref: "Alphard 黑色",
  },
  {
    source: "instagram",
    external_id: "ig-5002",
    author_name: "IG用戶·Ken",
    body: "Instagram 私訊：想約睇 Vellfire，請直接喺 IG 回覆我。",
    vehicle_ref: "Vellfire",
  },
  {
    source: "whatsapp",
    external_id: "wa-ig-5003",
    author_name: "Mandy",
    body: "我喺 Instagram 簡介撳咗連結（去 glorious.hk，utm_source=ig，link in bio），再經 WhatsApp 聯絡。想問星期六可唔可以睇 Alphard。",
    vehicle_ref: "Alphard",
    origin_site: "instagram",
  },
  {
    source: "whatsapp",
    external_id: "wa-ig-5004",
    author_name: "IG · Jason",
    body: "我喺 Instagram 撳咗 WhatsApp，唔係喺帖文留言。想問 Hiace 有冇白色。",
    vehicle_ref: "Hiace",
    origin_site: "instagram",
  },
];

const DEMO_REPLIES: Array<{ source: CommentSource; external_id: string; username: string; body: string }> = [
  {
    source: "28car",
    external_id: "28c-1001",
    username: "wing",
    body: "阿強你好，Alphard 2019 週末可以嚟葵涌陳列室睇。價錢可以再傾，我哋會預留架車。",
  },
  {
    source: "28car",
    external_id: "28c-1001",
    username: "tony",
    body: "我補充：星期六下午兩點陳列室有同事。",
  },
  {
    source: "glorious_web",
    external_id: "gw-2001",
    username: "wing",
    body: "已收到星期六參觀預約。請回覆方便時間，我哋會喺呢條官網留言跟進。",
  },
  {
    source: "facebook",
    external_id: "fb-3001",
    username: "jason",
    body: "黑色 Alphard 仲喺度。詳細規格我留喺呢條 Facebook 留言。",
  },
  {
    source: "instagram",
    external_id: "ig-5001",
    username: "wing",
    body: "阿偉你好，黑色 Alphard 仲喺度。呢則係 Instagram 留言，我喺收件箱回覆，唔使轉去 WhatsApp。",
  },
  {
    source: "whatsapp",
    external_id: "wa-28car-4002",
    username: "tony",
    body: "陳生你好，Vellfire 有現貨。你呢則係由 28car 撳 WhatsApp 入嚟，我喺系統內回覆。",
  },
  {
    source: "whatsapp",
    external_id: "wa-ig-5003",
    username: "wing",
    body: "Mandy 你好，星期六可以睇車。你呢則係由 Instagram 簡介連結（utm_source=ig）入嚟嘅 WhatsApp，唔係官網留言。",
  },
  {
    source: "whatsapp",
    external_id: "wa-direct-4001",
    username: "tony",
    body: "周先生你好，星期六可以睇 Alphard。呢則係直接打嚟公司 WhatsApp。",
  },
  {
    source: "whatsapp",
    external_id: "wa-direct-4001",
    username: "wing",
    body: "葵涌陳列室星期六 11:00–18:00，到時報我個名就得。",
  },
];

/**
 * 以 username 做 upsert：衝突時更新 display_name、is_admin、active。
 * 密碼只喺新插入嗰陣寫入示範密碼；已存在嘅 password_hash 唔覆寫，
 * 避免同事改咗密碼之後再跑 seed 被重設。收藏同事同樣唔會被強制改密碼。
 */
export function applySeedStaff(): void {
  const insertStaff = db.prepare(`
    INSERT INTO staff (username, display_name, password_hash, is_admin, active)
    VALUES (@username, @display_name, @password_hash, @is_admin, @active)
    ON CONFLICT(username) DO UPDATE SET
      display_name = excluded.display_name,
      is_admin = excluded.is_admin,
      active = excluded.active
  `);

  const passwordHash = hashPassword(DEMO_PASSWORD);
  const staffTx = db.transaction(() => {
    for (const s of SEED_STAFF) {
      insertStaff.run({
        username: s.username,
        display_name: s.display_name,
        password_hash: passwordHash,
        is_admin: s.is_admin,
        active: s.active,
      });
    }
  });
  staffTx();
}

export function seed(): void {
  console.log(`資料庫：${getDbPath()}`);
  applySeedStaff();
  const activeCount = SEED_STAFF.filter((s) => s.active === 1).length;
  console.log(
    `已寫入 ${SEED_STAFF.length} 位同事（${activeCount} 位可登入，其餘收藏）。新帳號預設密碼：${DEMO_PASSWORD}；已存在嘅密碼唔會改。`
  );

  const insertComment = db.prepare(`
    INSERT INTO comments (
      source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id,
      intake_kind, origin_site
    )
    VALUES (
      @source, @external_id, @author_name, @body, @vehicle_ref, @status, NULL,
      @intake_kind, @origin_site
    )
    ON CONFLICT(source, external_id) DO UPDATE SET
      author_name = excluded.author_name,
      body = excluded.body,
      vehicle_ref = excluded.vehicle_ref,
      status = excluded.status,
      intake_kind = excluded.intake_kind,
      origin_site = excluded.origin_site,
      updated_at = datetime('now')
  `);

  const findExisting = db.prepare(
    `SELECT id FROM comments WHERE source = ? AND external_id = ?`
  );
  const insertedKeys: Array<{ source: CommentSource; external_id: string }> = [];
  const commentTx = db.transaction(() => {
    for (const c of COMMENTS) {
      const existing = findExisting.get(c.source, c.external_id);
      const intakeKind: IntakeKind = c.source === "whatsapp" ? "whatsapp_click" : "site_comment";
      const originSite: OriginSite | null = c.source === "whatsapp" ? c.origin_site ?? null : null;
      insertComment.run({
        source: c.source,
        external_id: c.external_id,
        author_name: c.author_name,
        body: c.body,
        vehicle_ref: c.vehicle_ref,
        status: c.status ?? "open",
        intake_kind: intakeKind,
        origin_site: originSite,
      });
      if (!existing) insertedKeys.push({ source: c.source, external_id: c.external_id });
    }
  });
  commentTx();
  console.log(`已寫入 ${COMMENTS.length} 條示範留言`);

  // Clear assignees then rebalance so seed is deterministic-ish with least-open
  db.prepare(`UPDATE comments SET assignee_staff_id = NULL`).run();
  const n = autoAssignUnassigned();
  console.log(`已自動派單 ${n} 條`);

  const companyLine = ensureCompanyWhatsAppLine();
  const loadInserted = db.prepare(
    `SELECT id, source, author_name, body, intake_kind, origin_site
     FROM comments WHERE source = ? AND external_id = ?`
  );
  for (const item of insertedKeys) {
    const row = loadInserted.get(item.source, item.external_id) as
      | {
          id: number;
          source: string;
          author_name: string;
          body: string;
          intake_kind: string;
          origin_site: string | null;
        }
      | undefined;
    if (!row) continue;
    try {
      notifyNewComment(row);
    } catch (err) {
      console.error("[push] seed 推送未排程", err);
    }
  }

  const findComment = db.prepare(
    `SELECT id FROM comments WHERE source = ? AND external_id = ?`
  );
  const findStaff = db.prepare(`SELECT id FROM staff WHERE username = ? AND active = 1`);
  const deleteReplies = db.prepare(`DELETE FROM comment_replies WHERE comment_id = ?`);
  const replyTargets = new Set<string>();
  for (const reply of DEMO_REPLIES) replyTargets.add(`${reply.source}:${reply.external_id}`);
  for (const key of replyTargets) {
    const [source, externalId] = key.split(":");
    const row = findComment.get(source, externalId) as { id: number } | undefined;
    if (row) deleteReplies.run(row.id);
  }
  let replyCount = 0;
  for (const reply of DEMO_REPLIES) {
    const comment = findComment.get(reply.source, reply.external_id) as { id: number } | undefined;
    const staff = findStaff.get(reply.username) as { id: number } | undefined;
    if (!comment || !staff) {
      throw new Error(`示範回覆找不到留言或同事：${reply.source} ${reply.external_id} ${reply.username}`);
    }
    const saved = createStaffReply({ commentId: comment.id, staffId: staff.id, body: reply.body });
    if (!saved.ok) throw new Error(saved.error);
    replyCount += 1;
  }
  console.log(`已寫入 ${replyCount} 則示範回覆（出站 stub，未發送）`);
  console.log(
    `公司 WhatsApp 線路：${companyLine.phone_e164} ${companyLine.display_label}（${companyLine.kind}${companyLine.is_active ? "" : "，已停用"}）`
  );

  const counts = db
    .prepare(`SELECT source, intake_kind, origin_site, COUNT(*) AS n FROM comments GROUP BY source, intake_kind, origin_site ORDER BY source`)
    .all();
  console.log("來源統計：", counts);
  console.log("Seed 完成。");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(__filename);
}

if (isDirectRun()) seed();
