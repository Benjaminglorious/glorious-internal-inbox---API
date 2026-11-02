/**
 * upsertSiteComment 冪等同 Meta／site-comment webhook 解析煙霧測試。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { createHmac } from "crypto";
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

function main(): number {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-site-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    process.env.WEBHOOK_VERIFY_TOKEN = "demo-webhook-token";
    delete process.env.META_APP_SECRET;
    delete process.env.META_PAGE_ID;
    delete process.env.META_IG_BUSINESS_ACCOUNT_ID;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const site = require("../services/site-comments") as typeof import("../services/site-comments");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const meta = require("../services/meta-webhook") as typeof import("../services/meta-webhook");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const auth = require("../services/webhook-auth") as typeof import("../services/webhook-auth");
    appDb = dbMod.db;

    appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES ('a', '同事甲', 'x', 0, 1), ('b', '同事乙', 'x', 0, 1)`
      )
      .run();

    const first = site.upsertSiteComment({
      source: "fb",
      external_id: "fb-c-1",
      author_name: "阿華",
      body: "Alphard 仲喺度嗎？",
      vehicle_ref: "Alphard",
    });
    check("首次入庫成功", first.ok);
    if (!first.ok) return finish();
    check("source 收成 facebook", first.comment.source === "facebook");
    check("intake_kind=site_comment", first.comment.intake_kind === "site_comment");
    check("origin_site 空", first.comment.origin_site == null);
    check("created=true", first.created === true);
    check("已派同事", first.assigneeStaffId != null);

    const again = site.upsertSiteComment({
      source: "facebook",
      external_id: "fb-c-1",
      author_name: "阿華",
      body: "Alphard 仲喺度嗎？更新：想 sab",
      vehicle_ref: "Alphard",
    });
    check("重複 external_id 成功", again.ok);
    if (!again.ok) return finish();
    check("冪等：同一 id", again.comment.id === first.comment.id);
    check("created=false", again.created === false);
    check("內容已更新", again.comment.body.includes("更新"));
    check("負責人不變", again.assigneeStaffId === first.assigneeStaffId);

    const count = appDb.prepare(`SELECT COUNT(*) AS n FROM comments WHERE external_id = 'fb-c-1'`).get() as {
      n: number;
    };
    check("資料庫只有一列", count.n === 1);

    const bad = site.upsertSiteComment({
      source: "whatsapp",
      external_id: "x",
      author_name: "y",
      body: "z",
    });
    check("拒絕 whatsapp 作 site source", !bad.ok);

    const parsed = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          id: "PAGE",
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "fb-meta-9",
                message: "想問價錢",
                from: { id: "u1", name: "Cindy" },
              },
            },
          ],
          messaging: [
            {
              sender: { id: "m1" },
              message: { mid: "mid.1", text: "PM 你好" },
            },
          ],
        },
      ],
    });
    check("Meta feed+messaging 拆出 2 則", parsed.items.length === 2 && !parsed.error);
    check(
      "Meta 來源係 facebook",
      parsed.items.every((i) => i.source === "facebook")
    );
    check(
      "Meta feed 記住 comment id 同留言者 id",
      parsed.items[0]?.external_id === "fb-meta-9" &&
        parsed.items[0]?.meta_surface === "comment" &&
        parsed.items[0]?.meta_sender_id === "u1"
    );
    check(
      "Meta 私訊記住 mid 同 PSID",
      parsed.items[1]?.external_id === "mid.1" &&
        parsed.items[1]?.meta_surface === "message" &&
        parsed.items[1]?.meta_sender_id === "m1"
    );
    const storedMeta = site.upsertSiteComment(parsed.items[0]!);
    check(
      "入庫寫低 meta_sender_id",
      storedMeta.ok && storedMeta.comment.meta_sender_id === "u1" && storedMeta.comment.meta_surface === "comment"
    );
    const againMeta = site.upsertSiteComment({
      source: "facebook",
      external_id: "fb-meta-9",
      author_name: "Cindy",
      body: "想問價錢 更新",
    });
    check(
      "重複入庫唔洗走 meta 欄",
      againMeta.ok && againMeta.comment.meta_sender_id === "u1" && againMeta.comment.meta_surface === "comment"
    );

    const ig = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          changes: [
            {
              field: "comments",
              value: {
                id: "ig-c-1",
                text: "IG 帖文留言",
                from: { id: "ig1", username: "buyer" },
              },
            },
          ],
        },
      ],
    });
    check("IG comments 拆出 1 則", ig.items.length === 1 && ig.items[0]?.source === "instagram");
    check(
      "IG 留言記住 comment id 同用戶 id",
      ig.items[0]?.external_id === "ig-c-1" &&
        ig.items[0]?.meta_surface === "comment" &&
        ig.items[0]?.meta_sender_id === "ig1"
    );

    const savedPage = process.env.META_PAGE_ID;
    const savedIgId = process.env.META_IG_BUSINESS_ACCOUNT_ID;
    process.env.META_PAGE_ID = "111";
    process.env.META_IG_BUSINESS_ACCOUNT_ID = "222";
    const own = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: { item: "comment", verb: "add", comment_id: "own-1", message: "專頁回覆", from: { id: "111", name: "東榮" } },
            },
          ],
          messaging: [{ sender: { id: "111" }, message: { mid: "mid.own", text: "回聲" } }],
        },
      ],
    });
    const ownIg = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          changes: [
            {
              field: "comments",
              value: { id: "ig-own", text: "IG 自己回覆", from: { id: "222", username: "glorious" } },
            },
          ],
        },
      ],
    });
    const stillCustomer = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: { item: "comment", verb: "add", comment_id: "cust-1", message: "客戶", from: { id: "333", name: "客" } },
            },
          ],
        },
      ],
    });
    check("專頁自己嘅留言同私訊唔入庫", own.items.length === 0 && own.ignored);
    check("IG 專業帳號自己嘅留言唔入庫", ownIg.items.length === 0 && ownIg.ignored);
    check("客戶留言仍然入庫", stillCustomer.items.length === 1 && stillCustomer.items[0]?.meta_sender_id === "333");
    if (savedPage === undefined) delete process.env.META_PAGE_ID;
    else process.env.META_PAGE_ID = savedPage;
    if (savedIgId === undefined) delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
    else process.env.META_IG_BUSINESS_ACCOUNT_ID = savedIgId;

    const ignored = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [{ id: "PAGE", changes: [{ field: "feed", value: { item: "status", verb: "add" } }] }],
    });
    check("非留言 Meta 事件 ignored", ignored.ignored && ignored.items.length === 0);

    // 簽名：有 secret 時必須啱
    process.env.META_APP_SECRET = "test-secret";
    const raw = Buffer.from('{"object":"page","entry":[]}');
    const goodSig = "sha256=" + createHmac("sha256", "test-secret").update(raw).digest("hex");
    const fakeReq = {
      get: (name: string) => (name.toLowerCase() === "x-hub-signature-256" ? goodSig : undefined),
      rawBody: raw,
    } as unknown as import("express").Request;
    check("簽名正確通過", auth.verifyMetaSignature(fakeReq).ok);

    const badReq = {
      get: (name: string) => (name.toLowerCase() === "x-hub-signature-256" ? "sha256=deadbeef" : undefined),
      rawBody: raw,
    } as unknown as import("express").Request;
    check("簽名錯誤拒絕", !auth.verifyMetaSignature(badReq).ok);

    delete process.env.META_APP_SECRET;
    check("未設 secret 跳過簽名", auth.verifyMetaSignature({ get: () => undefined } as never).ok);

    const headerReq = (headers: Record<string, string>, rawBody?: Buffer) =>
      ({
        get: (name: string) => headers[name.toLowerCase()],
        rawBody,
      }) as unknown as import("express").Request;

    const openPost = auth.authorizeMetaPost(headerReq({}));
    check("POST 冇 token、未設 secret 通過", openPost.ok);
    const badPost = auth.authorizeMetaPost(headerReq({ "x-webhook-token": "nope" }));
    check("POST 錯 token 拒絕", !badPost.ok && badPost.status === 401 && badPost.error === "webhook token 不正確");
    const bearerPost = auth.authorizeMetaPost(headerReq({ authorization: "Bearer demo-webhook-token" }));
    check("POST Bearer token 通過", bearerPost.ok);

    process.env.META_APP_SECRET = "test-secret";
    const missingSig = auth.authorizeMetaPost(headerReq({}));
    check("POST 有 secret 但冇簽名拒絕", !missingSig.ok && missingSig.status === 401);
    const signedOpen = auth.authorizeMetaPost(headerReq({ "x-hub-signature-256": goodSig }, raw));
    check("POST 簽名正確且冇自訂 token 通過", signedOpen.ok);
    const signedBadToken = auth.authorizeMetaPost(
      headerReq({ "x-hub-signature-256": goodSig, "x-webhook-token": "nope" }, raw)
    );
    check("POST 簽名啱但 token 錯仍拒絕", !signedBadToken.ok && signedBadToken.status === 401);
    delete process.env.META_APP_SECRET;

    const savedToken = process.env.WEBHOOK_VERIFY_TOKEN;
    delete process.env.WEBHOOK_VERIFY_TOKEN;
    const missingEnv = auth.authorizeMetaPost(headerReq({}));
    check("POST 未設 WEBHOOK_VERIFY_TOKEN 回 503", !missingEnv.ok && missingEnv.status === 503);
    process.env.WEBHOOK_VERIFY_TOKEN = savedToken;

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\nupsertSiteComment／Meta 解析示範通過");
    return 0;
  } finally {
    appDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  function finish(): number {
    console.error(`\n${failures.length} 項失敗`);
    return 1;
  }
}

const code = main();
process.exit(code);
