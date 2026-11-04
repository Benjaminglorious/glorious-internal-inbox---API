/**
 * 同一留言者未完成對話共用一個 ID。已完成先至開新 ID。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

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

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-commenter-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const site = require("../services/site-comments") as typeof import("../services/site-comments");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const comments = require("../services/comments") as typeof import("../services/comments");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const replies = require("../services/replies") as typeof import("../services/replies");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const threads = require("../services/commenter-thread") as typeof import("../services/commenter-thread");
    appDb = dbMod.db;

    const staffId = Number(
      appDb
        .prepare(
          `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
           VALUES ('eddie', 'Eddie', 'x', 1, 1)`
        )
        .run().lastInsertRowid
    );
    wa.ensureCompanyWhatsAppLine();

    const first = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290001001",
      body: "第一句想問 Alphard",
      externalId: "wamid.ONE",
      authorName: "陳生",
    });
    const second = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "+852 9000 1001",
      body: "第二句想約星期六 UNIQUE-FOLLOW",
      externalId: "wamid.TWO",
      authorName: "陳生",
    });
    check("WhatsApp 兩個 wamid 成功", first.ok && second.ok);
    if (!first.ok || !second.ok) return 1;
    check("同一電話未完成共用 ID", second.comment.id === first.comment.id && second.created === false && second.appended === true);
    check("跟進唔改派", second.assigneeStaffId === first.assigneeStaffId && second.assigneeStaffId === staffId);
    const inbound = replies.listReplies(first.comment.id).filter((row) => row.direction === "inbound");
    check("第二句係客戶再留言", inbound.length === 1 && inbound[0]?.body.includes("UNIQUE-FOLLOW"));

    const retry = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290001001",
      body: "第二句想約星期六 UNIQUE-FOLLOW",
      externalId: "wamid.TWO",
    });
    const inboundAfterRetry = replies.listReplies(first.comment.id).filter((row) => row.direction === "inbound");
    check(
      "同一個 wamid 重試唔再加一句",
      retry.ok && retry.created === false && retry.appended === false && inboundAfterRetry.length === 1
    );

    const otherPhone = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290001002",
      body: "另一個人",
      externalId: "wamid.OTHER",
      authorName: "陳生",
    });
    check(
      "唔同電話即使同名都係另一個 ID",
      otherPhone.ok && otherPhone.created === true && otherPhone.comment.id !== first.comment.id
    );

    const answered = await replies.createStaffReply({
      commentId: first.comment.id,
      staffId,
      body: "系統回覆",
    });
    const third = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290001001",
      body: "處理中再問多句",
      externalId: "wamid.THREE",
    });
    check(
      "處理中仍然用同一個 ID",
      answered.ok &&
        answered.comment.status === "in_progress" &&
        third.ok &&
        third.comment.id === first.comment.id &&
        third.comment.status === "in_progress"
    );

    comments.updateStatus(first.comment.id, "done");
    const afterDone = wa.routeWhatsAppInbound({
      toPhone: "85221740001",
      fromPhone: "85290001001",
      body: "完成之後新查詢",
      externalId: "wamid.FOUR",
    });
    check(
      "已完成之後先開新 ID",
      afterDone.ok && afterDone.created === true && afterDone.comment.id !== first.comment.id
    );
    const doneRow = comments.getComment(first.comment.id);
    check("舊 ID 維持已完成", doneRow?.status === "done");
    if (afterDone.ok) {
      const blocked = threads.blockingOpenThreadId(first.comment.id, "open");
      const unchanged = comments.updateStatus(first.comment.id, "open");
      check("有未完成對話時唔可以重開舊 ID", blocked === afterDone.comment.id && unchanged?.status === "done");
      comments.updateStatus(afterDone.comment.id, "done");
      const reopened = comments.updateStatus(first.comment.id, "open");
      check("另一條已完成之後可以重開", reopened?.status === "open");
      comments.updateStatus(first.comment.id, "done");
    }

    const found = comments.listComments({ q: "UNIQUE-FOLLOW" });
    check(
      "搜尋搵到跟進句，而且只得原本個 ID",
      found.length === 1 && found[0]?.id === first.comment.id
    );

    const fb1 = site.upsertSiteComment({
      source: "facebook",
      external_id: "1111111111_2222222222_9001",
      author_name: "Cindy",
      body: "帖文留言",
      meta_sender_id: "17841400000000021",
      meta_surface: "comment",
    });
    const fbDm = site.upsertSiteComment({
      source: "facebook",
      external_id: "mid.CINDYDM",
      author_name: "Cindy",
      body: "轉私訊",
      meta_sender_id: "17841400000000021",
      meta_surface: "message",
    });
    check("Facebook 同一 PSID 帖文同私訊共用 ID", fb1.ok && fbDm.ok && fbDm.comment.id === fb1.comment.id && fbDm.appended);
    check(
      "併入私訊唔改原來回覆目標",
      fbDm.ok && fb1.ok && fbDm.comment.meta_surface === "comment" && fbDm.comment.external_id === fb1.comment.external_id
    );
    const fbOther = site.upsertSiteComment({
      source: "facebook",
      external_id: "1111111111_2222222222_9002",
      author_name: "Cindy",
      body: "另一個人同名",
      meta_sender_id: "17841400000000022",
      meta_surface: "comment",
    });
    check("唔同 PSID 即使同名都係另一個 ID", fbOther.ok && fb1.ok && fbOther.comment.id !== fb1.comment.id);

    const ig1 = site.upsertSiteComment({
      source: "instagram",
      external_id: "ig-mid-1",
      author_name: "iguser",
      body: "IG 第一句",
      meta_sender_id: "17841400000000999",
      meta_surface: "message",
    });
    const ig2 = site.upsertSiteComment({
      source: "instagram",
      external_id: "ig-mid-2",
      author_name: "iguser",
      body: "IG 第二句",
      meta_sender_id: "17841400000000999",
      meta_surface: "message",
    });
    check("Instagram 同一 IGSID 共用 ID", ig1.ok && ig2.ok && ig2.comment.id === ig1.comment.id);

    const car1 = site.upsertSiteComment({
      source: "28car",
      external_id: "28car:s1:m1",
      author_name: "李先生",
      body: "第一架車",
      entry_path: "28car_board",
    });
    const car2 = site.upsertSiteComment({
      source: "28car",
      external_id: "28car:s2:m2",
      author_name: " 李先生 ",
      body: "第二架車",
      entry_path: "28car_board",
    });
    const carOther = site.upsertSiteComment({
      source: "28car",
      external_id: "28car:s3:m3",
      author_name: "周先生",
      body: "另一位",
      entry_path: "28car_board",
    });
    check("28car 同名未完成共用 ID", car1.ok && car2.ok && car2.comment.id === car1.comment.id);
    check("28car 唔同名係另一個 ID", carOther.ok && car1.ok && carOther.comment.id !== car1.comment.id);

    const unknown1 = site.upsertSiteComment({
      source: "facebook",
      external_id: "anon-1",
      author_name: "未知用戶",
      body: "冇身份一",
    });
    const unknown2 = site.upsertSiteComment({
      source: "facebook",
      external_id: "anon-2",
      author_name: "未知用戶",
      body: "冇身份二",
    });
    check(
      "未知用戶唔會因為名稱一樣被合併",
      unknown1.ok && unknown2.ok && unknown1.comment.id !== unknown2.comment.id
    );

    appDb.exec(`DROP INDEX IF EXISTS idx_comments_one_open_commenter`);
    const legacyStaff = staffId;
    const insertLegacy = appDb.prepare(
      `INSERT INTO comments (
         source, external_id, author_name, body, status, assignee_staff_id,
         intake_kind, wa_from_phone, wa_to_phone, commenter_key
       ) VALUES ('whatsapp', ?, ?, ?, 'open', ?, 'whatsapp_click', '85291110000', '85221740001', 'wa:85291110000')`
    );
    const idA = Number(insertLegacy.run("wamid.LEGACY-A", "舊客", "舊第一句", legacyStaff).lastInsertRowid);
    const idB = Number(insertLegacy.run("wamid.LEGACY-B", "舊客", "舊第二句", legacyStaff).lastInsertRowid);
    appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status)
         VALUES (?, ?, 'outbound', '舊回覆要保留', 'stub')`
      )
      .run(idB, legacyStaff);
    const merged = threads.unifyOpenCommenterThreads();
    const kept = comments.getComment(idA);
    const gone = comments.getComment(idB);
    const moved = replies.listReplies(idA);
    check(
      "已存在嘅未完成重複 ID 會併入較早嗰個",
      merged >= 1 && !!kept && kept.status !== "done" && gone == null && moved.some((row) => row.body === "舊回覆要保留") && moved.some((row) => row.direction === "inbound" && row.body === "舊第二句"),
      `merged=${merged} kept=${kept?.id ?? "none"} gone=${gone?.id ?? "none"}`
    );
    const doneKept = Number(
      appDb
        .prepare(
          `INSERT INTO comments (
             source, external_id, author_name, body, status, assignee_staff_id,
             intake_kind, wa_from_phone, wa_to_phone, commenter_key
           ) VALUES ('whatsapp', 'wamid.LEGACY-DONE', '舊客', '已完成保留', 'done', ?, 'whatsapp_click', '85291110000', '85221740001', 'wa:85291110000')`
        )
        .run(legacyStaff).lastInsertRowid
    );
    threads.unifyOpenCommenterThreads();
    check("已完成嘅舊 ID 唔會被合併走", comments.getComment(doneKept)?.status === "done");

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\n同一留言者 ID 示範通過");
    return 0;
  } finally {
    appDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
