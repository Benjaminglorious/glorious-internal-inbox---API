import "dotenv/config";
import { db, getDbPath } from "./index";
import { hashPassword } from "../auth/passwords";
import { autoAssignUnassigned } from "../services/assign";
import type { CommentSource } from "../types";

/** Default demo password — MUST be changed in production. */
export const DEMO_PASSWORD = "Glorious2026!";

const STAFF: Array<{ username: string; display_name: string; is_admin: number }> = [
  { username: "tony", display_name: "陳東榮", is_admin: 1 },
  { username: "wing", display_name: "李詠詩", is_admin: 0 },
  { username: "kaixin", display_name: "張嘉欣", is_admin: 0 },
  { username: "ming", display_name: "王明軒", is_admin: 0 },
  { username: "mei", display_name: "陳美玲", is_admin: 0 },
  { username: "ho", display_name: "何志豪", is_admin: 0 },
  { username: "yan", display_name: "林雅雯", is_admin: 0 },
  { username: "chun", display_name: "黃俊傑", is_admin: 0 },
  { username: "sze", display_name: "鄭詩敏", is_admin: 0 },
  { username: "kit", display_name: "吳家傑", is_admin: 0 },
  { username: "yuki", display_name: "趙雪兒", is_admin: 0 },
];

interface DemoComment {
  source: CommentSource;
  external_id: string;
  author_name: string;
  body: string;
  vehicle_ref: string | null;
  status?: "open" | "in_progress" | "done";
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
];

function seed(): void {
  console.log(`資料庫：${getDbPath()}`);

  const insertStaff = db.prepare(`
    INSERT INTO staff (username, display_name, password_hash, is_admin, active)
    VALUES (@username, @display_name, @password_hash, @is_admin, 1)
    ON CONFLICT(username) DO UPDATE SET
      display_name = excluded.display_name,
      password_hash = excluded.password_hash,
      is_admin = excluded.is_admin,
      active = 1
  `);

  const passwordHash = hashPassword(DEMO_PASSWORD);
  const staffTx = db.transaction(() => {
    for (const s of STAFF) {
      insertStaff.run({
        username: s.username,
        display_name: s.display_name,
        password_hash: passwordHash,
        is_admin: s.is_admin,
      });
    }
  });
  staffTx();
  console.log(`已寫入 ${STAFF.length} 位同事（預設密碼：${DEMO_PASSWORD}）`);

  const insertComment = db.prepare(`
    INSERT INTO comments (source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id)
    VALUES (@source, @external_id, @author_name, @body, @vehicle_ref, @status, NULL)
    ON CONFLICT(source, external_id) DO UPDATE SET
      author_name = excluded.author_name,
      body = excluded.body,
      vehicle_ref = excluded.vehicle_ref,
      status = excluded.status,
      updated_at = datetime('now')
  `);

  const commentTx = db.transaction(() => {
    for (const c of COMMENTS) {
      insertComment.run({
        source: c.source,
        external_id: c.external_id,
        author_name: c.author_name,
        body: c.body,
        vehicle_ref: c.vehicle_ref,
        status: c.status ?? "open",
      });
    }
  });
  commentTx();
  console.log(`已寫入 ${COMMENTS.length} 條示範留言`);

  // Clear assignees then rebalance so seed is deterministic-ish with least-open
  db.prepare(`UPDATE comments SET assignee_staff_id = NULL`).run();
  const n = autoAssignUnassigned();
  console.log(`已自動派單 ${n} 條`);

  const counts = db
    .prepare(
      `SELECT source, COUNT(*) AS n FROM comments GROUP BY source ORDER BY source`
    )
    .all();
  console.log("來源統計：", counts);
  console.log("Seed 完成。");
}

seed();
