/**
 * 示範 routeWhatsAppInbound：
 * 公司總機用最少未完成、同數則較細 staff id；
 * 同事個人線路派畀綁定同事；未知線路入庫但未派。
 *
 * 先整一個舊 schema（source 冇 whatsapp）再載入 app，順便確認遷移。
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { COMPANY_WHATSAPP_PHONE } from "../config";

const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.error(`FAIL ${line}`);
    return;
  }
  console.log(`OK   ${name}`);
}

function main(): number {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-wa-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;

  try {
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL CHECK (source IN ('28car', 'glorious_web', 'facebook')),
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
      INSERT INTO staff (username, display_name, password_hash, is_admin, active)
      VALUES ('loaded', '同事甲', 'x', 0, 1);
      INSERT INTO comments (source, external_id, author_name, body, vehicle_ref, status, assignee_staff_id)
      VALUES ('28car', 'legacy-1', '舊客', '遷移前留言', NULL, 'open', 1);
    `);
    legacy.close();

    process.env.DATABASE_PATH = dbFile;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    appDb = dbMod.db;

    const ddl = appDb
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'`)
      .get() as { sql: string };
    const commentCount = appDb.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number };
    check("舊留言遷移後仍在", commentCount.n === 1);
    check("comments.source 包含 whatsapp", ddl.sql.includes("whatsapp"));

    const survived = appDb.prepare(`SELECT body, assignee_staff_id FROM comments WHERE id = 1`).get() as {
      body: string;
      assignee_staff_id: number;
    };
    check("遷移保留內容同負責人", survived.body === "遷移前留言" && survived.assignee_staff_id === 1);

    const staffB = appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES ('free', '同事乙', 'x', 0, 1)`
      )
      .run();
    const staffAId = 1;
    const staffBId = Number(staffB.lastInsertRowid);

    wa.ensureCompanyWhatsAppLine();
    const company = wa.listWhatsAppLines().find((line) => line.phone_e164 === COMPANY_WHATSAPP_PHONE);
    check(
      "seed 公司總機 85221740001／東榮總機",
      !!company && company.kind === "company" && company.staff_id == null && company.display_label === "東榮總機"
    );

    const staffPhone = "85261111111";
    const bound = wa.addStaffWhatsAppLine({ staffId: staffAId, phone: "+852 6111-1111", displayLabel: "同事甲個人" });
    check("綁定同事甲個人線路", bound.ok && bound.ok && bound.line.staff_id === staffAId);
    check("拒絕重複綁定", !wa.addStaffWhatsAppLine({ staffId: staffBId, phone: staffPhone }).ok);
    check(
      "拒絕將總機綁成個人線路",
      !wa.addStaffWhatsAppLine({ staffId: staffBId, phone: "85221740001" }).ok
    );

    let staffCheckFailed = false;
    try {
      appDb
        .prepare(
          `INSERT INTO whatsapp_lines (phone_e164, display_label, kind, staff_id, is_active)
           VALUES ('85269999999', 'bad', 'staff', NULL, 1)`
        )
        .run();
    } catch {
      staffCheckFailed = true;
    }
    check("staff 線路必須有 staff_id", staffCheckFailed);

    const company1 = wa.routeWhatsAppInbound({
      toPhone: "+852 2174 0001",
      fromPhone: "85290000001",
      body: "總機第一則",
      externalId: "m-company-1",
    });
    check(
      "總機第一則派畀未完成較少嘅同事乙",
      company1.ok && company1.outcome === "company" && company1.assigneeStaffId === staffBId,
      company1.ok ? `assignee=${company1.assigneeStaffId} outcome=${company1.outcome}` : company1.error
    );

    const staffMsg = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85290000002",
      body: "打去同事甲",
      externalId: "m-staff-1",
      authorName: "陳生",
    });
    check(
      "個人線路派畀同事甲（即使未完成較多）",
      staffMsg.ok && staffMsg.outcome === "staff" && staffMsg.assigneeStaffId === staffAId && staffMsg.comment.author_name === "陳生",
      staffMsg.ok ? `assignee=${staffMsg.assigneeStaffId}` : staffMsg.error
    );

    const company2 = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85290000003",
      body: "總機第二則",
      externalId: "m-company-2",
    });
    check(
      "總機第二則仍派同事乙（甲已有舊單加個人線路）",
      company2.ok && company2.assigneeStaffId === staffBId,
      company2.ok ? `assignee=${company2.assigneeStaffId}` : company2.error
    );

    const company3 = wa.routeWhatsAppInbound({
      toPhone: "0085221740001",
      fromPhone: "85290000004",
      body: "總機第三則（同數取較細 id）",
      externalId: "m-company-3",
    });
    check(
      "未完成同數時派 staff id 較細嘅同事甲",
      company3.ok && company3.outcome === "company" && company3.assigneeStaffId === staffAId,
      company3.ok ? `assignee=${company3.assigneeStaffId} A=${staffAId} B=${staffBId}` : company3.error
    );

    const retry = wa.routeWhatsAppInbound({
      toPhone: COMPANY_WHATSAPP_PHONE,
      fromPhone: "85290000001",
      body: "總機第一則",
      externalId: "m-company-1",
    });
    check(
      "同一 externalId 冪等、唔改派",
      retry.ok &&
        company1.ok &&
        retry.created === false &&
        retry.comment.id === company1.comment.id &&
        retry.assigneeStaffId === staffBId &&
        retry.comment.body === "總機第一則",
      retry.ok ? `id=${retry.comment.id} created=${retry.created}` : retry.error
    );

    const unknown = wa.routeWhatsAppInbound({
      toPhone: "85269998888",
      fromPhone: "85290000005",
      body: "打去未綁定號碼",
      externalId: "m-unknown-1",
    });
    check(
      "未知線路入庫但未派",
      unknown.ok && unknown.outcome === "unassigned_unknown_line" && unknown.assigneeStaffId == null,
      unknown.ok ? `outcome=${unknown.outcome} assignee=${unknown.assigneeStaffId}` : unknown.error
    );

    const thread1 = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85292220000",
      body: "第一句",
    });
    const thread2 = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85292220000",
      body: "第二句",
    });
    check(
      "冇 externalId 時同一客人合成對話並維持同事甲",
      thread1.ok &&
        thread2.ok &&
        thread2.created === false &&
        thread2.comment.id === thread1.comment.id &&
        thread2.comment.body.includes("第一句") &&
        thread2.comment.body.includes("第二句") &&
        thread2.assigneeStaffId === staffAId
    );

    if (bound.ok) {
      const deactivated = wa.deactivateWhatsAppLine(bound.line.id);
      check("停用同事線路", deactivated.ok && deactivated.line.is_active === false);
    }
    const afterOff = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85290000006",
      body: "線路已停用",
      externalId: "m-staff-off",
    });
    check(
      "已停用線路當未知線路",
      afterOff.ok && afterOff.outcome === "unassigned_unknown_line" && afterOff.assigneeStaffId == null
    );

    const rebound = wa.addStaffWhatsAppLine({ staffId: staffAId, phone: staffPhone });
    check("重新綁定已停用號碼", rebound.ok && rebound.line.is_active);
    appDb.prepare(`UPDATE staff SET active = 0 WHERE id = ?`).run(staffAId);
    const inactiveStaff = wa.routeWhatsAppInbound({
      toPhone: staffPhone,
      fromPhone: "85290000007",
      body: "同事已停用",
      externalId: "m-staff-inactive",
    });
    check(
      "綁定同事已停用則未派",
      inactiveStaff.ok &&
        inactiveStaff.outcome === "unassigned_inactive_staff" &&
        inactiveStaff.assigneeStaffId == null
    );

    const meta = wa.parseWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: "+852 2174 0001" },
                contacts: [{ wa_id: "85293330000", profile: { name: "阿強" } }],
                messages: [
                  {
                    from: "85293330000",
                    id: "wamid.DEMO",
                    type: "text",
                    text: { body: "Alphard 幾多錢？" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    check("Meta payload 解析到一則文字", meta.messages.length === 1 && meta.messages[0]?.authorName === "阿強");
    const metaRouted = meta.messages[0] ? wa.routeWhatsAppInbound(meta.messages[0]) : null;
    check(
      "Meta 總機訊息入庫",
      !!metaRouted?.ok && metaRouted.outcome === "company" && metaRouted.comment.author_name === "阿強" && metaRouted.comment.source === "whatsapp"
    );

    const statusOnly = wa.parseWhatsAppWebhookPayload({
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    });
    check("Meta 狀態回呼忽略", statusOnly.ignored && statusOnly.messages.length === 0 && !statusOnly.error);

    const bad = wa.parseWhatsAppWebhookPayload({ foo: 1 });
    check("認唔到嘅 JSON 回報錯誤", !!bad.error && bad.messages.length === 0);

    const openCounts = appDb
      .prepare(
        `SELECT assignee_staff_id AS id, COUNT(*) AS n
         FROM comments
         WHERE status IN ('open', 'in_progress') AND assignee_staff_id IS NOT NULL
         GROUP BY assignee_staff_id
         ORDER BY id`
      )
      .all();
    console.log("未完成分佈：", openCounts);

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\nrouteWhatsAppInbound 示範通過");
    return 0;
  } finally {
    appDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const code = main();
process.exit(code);
