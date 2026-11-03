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

async function main(): Promise<number> {
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
                post_id: "1111111111_2222222222",
                message: "想問價錢",
                from: { id: "u1", name: "Cindy" },
                post: {
                  id: "1111111111_2222222222",
                  permalink_url: "https://www.facebook.com/GloriousMotors/posts/2222222222",
                  message: "紅色 Alphard 現貨",
                },
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
      "Meta feed 記住帖文編號、連結同內容",
      parsed.items[0]?.meta_post_id === "1111111111_2222222222" &&
        parsed.items[0]?.meta_post_caption === "紅色 Alphard 現貨" &&
        parsed.items[0]?.meta_post_permalink === "https://www.facebook.com/GloriousMotors/posts/2222222222"
    );
    check("Meta 私訊唔帶帖文", parsed.items[1]?.meta_post_id == null && parsed.items[1]?.meta_post_caption == null);
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
    check(
      "入庫寫低帖文",
      storedMeta.ok &&
        storedMeta.comment.meta_post_id === "1111111111_2222222222" &&
        storedMeta.comment.meta_post_caption === "紅色 Alphard 現貨" &&
        storedMeta.comment.meta_post_permalink === "https://www.facebook.com/GloriousMotors/posts/2222222222"
    );
    const againMeta = site.upsertSiteComment({
      source: "facebook",
      external_id: "fb-meta-9",
      author_name: "Cindy",
      body: "想問價錢 更新",
    });
    check(
      "重複入庫唔洗走 meta 欄",
      againMeta.ok &&
        againMeta.comment.meta_sender_id === "u1" &&
        againMeta.comment.meta_surface === "comment" &&
        againMeta.comment.meta_post_id === "1111111111_2222222222" &&
        againMeta.comment.meta_post_caption === "紅色 Alphard 現貨"
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
                media: {
                  id: "178900000000099",
                  media_product_type: "FEED",
                  caption: "白色 Alphard 限量",
                  permalink: "https://www.instagram.com/p/abc123/",
                },
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
    check(
      "IG 留言記住 media id、caption 同 permalink",
      ig.items[0]?.meta_post_id === "178900000000099" &&
        ig.items[0]?.meta_post_caption === "白色 Alphard 限量" &&
        ig.items[0]?.meta_post_permalink === "https://www.instagram.com/p/abc123/"
    );

    const inferred = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "178900000000001_178900000000002_9001",
                message: "冇 post_id 都要猜到帖文",
                from: { id: "u9", name: "客人" },
              },
            },
          ],
        },
      ],
    });
    check(
      "Facebook comment id 三段數字可以還原帖文 id",
      inferred.items[0]?.meta_post_id === "178900000000001_178900000000002" &&
        inferred.items[0]?.external_id === "178900000000001_178900000000002_9001"
    );
    const badLink = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "fb-bad-link",
                message: "壞連結",
                from: { id: "u8", name: "客人" },
                post: { id: "155_166", permalink_url: "javascript:alert(1)", message: "帖文" },
              },
            },
          ],
        },
      ],
    });
    check(
      "帖文連結必須係 http(s)",
      badLink.items[0]?.meta_post_id === "155_166" && badLink.items[0]?.meta_post_permalink == null
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

    const postCols = new Set(
      (appDb.prepare(`PRAGMA table_info(comments)`).all() as Array<{ name: string }>).map((row) => row.name)
    );
    check(
      "留言表有帖文欄",
      postCols.has("meta_post_id") && postCols.has("meta_post_permalink") && postCols.has("meta_post_caption")
    );

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const graph = require("../adapters/meta-graph") as typeof import("../adapters/meta-graph");
    delete process.env.META_PAGE_ACCESS_TOKEN;
    const noToken = await graph.lookupMetaParentPost({ channel: "facebook", postId: "1111111111_2222222222" });
    check("冇 Page token 唔打 Graph 補帖文", noToken == null);

    const bare = site.upsertSiteComment({
      source: "facebook",
      external_id: "178900000000002_9001",
      author_name: "客人",
      body: "帖文編號同 comment id 分開",
      meta_surface: "comment",
      meta_post_id: "1111111111_2222222222",
    });
    check("先入庫帖文編號", bare.ok && bare.comment.meta_post_caption == null);
    const originalFetch = globalThis.fetch;
    process.env.META_PAGE_ACCESS_TOKEN = "page-token";
    process.env.META_GRAPH_VERSION = "v21.0";
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      check(
        "補帖文係 GET 帖文，唔係回覆 comment",
        href.includes("/1111111111_2222222222") && !href.includes("/comments") && !href.includes("/replies")
      );
      return new Response(
        JSON.stringify({
          id: "178900000000001_178900000000002",
          message: "Graph 補回嘅帖文",
          permalink_url: "https://www.facebook.com/permalink.php?story_fbid=2&id=1",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      const looked = await graph.lookupMetaParentPost({
        channel: "facebook",
        postId: "1111111111_2222222222",
      });
      check(
        "Graph 補到 caption 同 permalink",
        looked?.caption === "Graph 補回嘅帖文" &&
          looked.permalink === "https://www.facebook.com/permalink.php?story_fbid=2&id=1"
      );
      if (bare.ok && looked) {
        const filled = site.fillMetaPostIfMissing(bare.comment.id, {
          id: "1111111111_2222222222",
          caption: looked.caption,
          permalink: looked.permalink,
        });
        check(
          "空白帖文欄先補，external_id 仍然係 comment id",
          filled?.meta_post_caption === "Graph 補回嘅帖文" &&
            filled.meta_post_permalink === "https://www.facebook.com/permalink.php?story_fbid=2&id=1" &&
            filled.external_id === "178900000000002_9001" &&
            filled.meta_post_id === "1111111111_2222222222"
        );
        const target = graph.resolveMetaReplyTarget({
          channel: "facebook",
          externalId: filled?.external_id || "",
          metaSenderId: null,
          metaSurface: "comment",
        });
        check(
          "補帖文之後回覆仍然打 comment id",
          target.ok && target.kind === "comment" && target.commentId === "178900000000002_9001"
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.META_PAGE_ACCESS_TOKEN;
      delete process.env.META_GRAPH_VERSION;
    }

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

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
