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

    // Instagram Messaging「messages」：客戶睇完帖文再傳文字，referral 喺 message 入面。
    // 形狀跟 Meta 文件：source POST、type OPEN_THREAD、post_id。客戶句子唔係 caption。
    const igFromPost = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "17841400000000001",
          time: 1731600000000,
          messaging: [
            {
              sender: { id: "17841400000000777" },
              recipient: { id: "17841400000000001" },
              timestamp: 1731599999000,
              message: {
                mid: "aWdfZAG1howmuch",
                text: "How much?",
                referral: {
                  source: "POST",
                  type: "OPEN_THREAD",
                  post_id: "178900000000099",
                },
              },
            },
          ],
        },
      ],
    });
    check(
      "IG 帖文私訊記住 post id，客戶句子唔係 caption",
      igFromPost.items.length === 1 &&
        igFromPost.items[0]?.source === "instagram" &&
        igFromPost.items[0]?.meta_surface === "message" &&
        igFromPost.items[0]?.body === "How much?" &&
        igFromPost.items[0]?.meta_post_id === "178900000000099" &&
        igFromPost.items[0]?.meta_post_caption == null &&
        igFromPost.items[0]?.meta_post_permalink == null &&
        igFromPost.items[0]?.external_id === "aWdfZAG1howmuch" &&
        igFromPost.items[0]?.meta_sender_id === "17841400000000777"
    );
    const storedIgPost = site.upsertSiteComment(igFromPost.items[0]!);
    check(
      "IG 帖文私訊入庫寫低 meta_post_id，表面仍然係私訊",
      storedIgPost.ok &&
        storedIgPost.comment.meta_surface === "message" &&
        storedIgPost.comment.body === "How much?" &&
        storedIgPost.comment.meta_post_id === "178900000000099" &&
        storedIgPost.comment.meta_post_caption == null
    );
    const igFollow = site.upsertSiteComment({
      source: "instagram",
      external_id: "aWdfZAG1follow",
      author_name: "17841400000000777",
      body: "再問交車",
      meta_sender_id: "17841400000000777",
      meta_surface: "message",
    });
    check(
      "跟住冇 referral 嘅 IG 私訊唔洗走帖文",
      igFollow.ok &&
        storedIgPost.ok &&
        igFollow.comment.id === storedIgPost.comment.id &&
        igFollow.comment.meta_post_id === "178900000000099" &&
        igFollow.comment.meta_surface === "message" &&
        igFollow.comment.body === "How much?"
    );

    // 文件上嘅 Click-to-Direct：source ADS、type OPEN_THREAD、ads_context_data。
    // photo_url／video_url 係廣告預覽，唔係客戶相片，亦唔係原帖連結。
    const igAd = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "17841400000000001",
          time: 1569262486134,
          messaging: [
            {
              sender: { id: "17841400000000778" },
              recipient: { id: "17841400000000001" },
              timestamp: 1569262485349,
              message: {
                mid: "aWdfZAG1ctd",
                text: "How much?",
                referral: {
                  ref: "REF-DATA-IN-AD-IF-SPECIFIED",
                  ad_id: "120210000000111",
                  source: "ADS",
                  type: "OPEN_THREAD",
                  ads_context_data: {
                    ad_title: "紅色 Alphard 現貨",
                    photo_url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1",
                    video_url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2",
                    post_id: "178900000000100",
                  },
                },
              },
            },
          ],
        },
      ],
    });
    check(
      "IG 廣告私訊用 post_id 同 ad_title，唔用預覽圖或客戶句子",
      igAd.items.length === 1 &&
        igAd.items[0]?.body === "How much?" &&
        igAd.items[0]?.meta_post_id === "178900000000100" &&
        igAd.items[0]?.meta_post_caption === "紅色 Alphard 現貨" &&
        igAd.items[0]?.meta_post_permalink == null &&
        (igAd.items[0]?.attachments?.length ?? 0) === 0
    );

    // 只有廣告編號、冇 post_id：用 ad_id，caption 仍然係 ad_title。
    const igAdIdOnly = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "17841400000000779" },
              message: {
                mid: "aWdfZAG1adonly",
                text: "想睇車",
                referral: {
                  ad_id: 120210000000222,
                  source: "ADS",
                  type: "OPEN_THREAD",
                  ads_context_data: {
                    ad_title: "白色七人車",
                    photo_url: "https://scontent.xx.fbcdn.net/ad.jpg",
                  },
                },
              },
            },
          ],
        },
      ],
    });
    check(
      "IG 廣告冇 post_id 就記住 ad_id",
      igAdIdOnly.items[0]?.meta_post_id === "120210000000222" &&
        igAdIdOnly.items[0]?.meta_post_caption === "白色七人車" &&
        igAdIdOnly.items[0]?.body === "想睇車"
    );

    // 文件上嘅 messaging_referral：已有對話再開，referral 喺 event，冇 message。
    const igMe = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "17841400000000001",
          time: 1502905976963,
          messaging: [
            {
              sender: { id: "17841400000000780" },
              recipient: { id: "17841400000000001" },
              timestamp: 1502905976377,
              referral: {
                ref: "INFORMATION-INCLUDED-IN-REF-PARAMETER-OF-IGME-LINK",
                source: "IGME-SOURCE-LINK",
                type: "OPEN_THREAD",
              },
            },
          ],
        },
      ],
    });
    check("ig.me referral 冇帖文就唔開新私訊", igMe.ignored && igMe.items.length === 0);

    const igMeWithText = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "17841400000000780" },
              message: {
                mid: "aWdfZAG1igme",
                text: "由 ig.me 入嚟",
                referral: {
                  ref: "bio",
                  source: "SHORTLINKS",
                  type: "OPEN_THREAD",
                },
              },
            },
          ],
        },
      ],
    });
    check(
      "ig.me 有句子都唔寫帖文",
      igMeWithText.items[0]?.body === "由 ig.me 入嚟" &&
        igMeWithText.items[0]?.meta_post_id == null &&
        igMeWithText.items[0]?.meta_post_caption == null &&
        igMeWithText.items[0]?.meta_post_permalink == null
    );

    // Messenger messaging_referrals 文件：event 級 ADS referral，ads_context_data.post_id。
    const fbReferralOnly = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          id: "1111111111",
          time: 1458692752478,
          messaging: [
            {
              sender: { id: "5555000000000001" },
              recipient: { id: "1111111111" },
              timestamp: 1458692752478,
              referral: {
                ref: "alphard",
                ad_id: "52540693396957",
                source: "ADS",
                type: "OPEN_THREAD",
                ads_context_data: {
                  ad_title: "紅色 Alphard 現貨",
                  photo_url: "https://scontent.xx.fbcdn.net/ad.jpg",
                  video_url: "https://scontent.xx.fbcdn.net/ad.mp4",
                  post_id: "1111111111_2222222222",
                  product_id: "999",
                },
              },
            },
          ],
        },
      ],
    });
    check(
      "Facebook 只有 referral 都記住帖文，正文唔係廣告標題",
      fbReferralOnly.items.length === 1 &&
        fbReferralOnly.items[0]?.source === "facebook" &&
        fbReferralOnly.items[0]?.meta_surface === "message" &&
        fbReferralOnly.items[0]?.body === "（由帖文開啟私訊）" &&
        fbReferralOnly.items[0]?.meta_post_id === "1111111111_2222222222" &&
        fbReferralOnly.items[0]?.meta_post_caption === "紅色 Alphard 現貨" &&
        fbReferralOnly.items[0]?.meta_post_permalink == null &&
        fbReferralOnly.items[0]?.external_id === "ref:5555000000000001:1111111111_2222222222" &&
        fbReferralOnly.items[0]?.meta_sender_id === "5555000000000001"
    );

    const fbPostLink = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "5555000000000002" },
              message: {
                mid: "mid.fbpost",
                text: "How much?",
                referral: {
                  source: "IG_POST",
                  type: "OPEN_THREAD",
                  post_id: "178900000000101",
                  permalink: "https://www.instagram.com/p/CxAb12/",
                  title: "白色 Alphard 限量",
                },
              },
            },
          ],
        },
      ],
    });
    check(
      "source IG_POST 記住 permalink 同 title，客戶句子另計",
      fbPostLink.items[0]?.source === "facebook" &&
        fbPostLink.items[0]?.body === "How much?" &&
        fbPostLink.items[0]?.meta_post_id === "178900000000101" &&
        fbPostLink.items[0]?.meta_post_permalink === "https://www.instagram.com/p/CxAb12/" &&
        fbPostLink.items[0]?.meta_post_caption === "白色 Alphard 限量"
    );

    const storyReply = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "17841400000000781" },
              message: {
                mid: "aWdfZAG1story",
                text: "How much?",
                reply_to: {
                  story: {
                    id: "178900000000088",
                    url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=178900000000088",
                  },
                },
              },
            },
          ],
        },
      ],
    });
    check(
      "回覆限時動態記住 story id，CDN 唔當原帖",
      storyReply.items[0]?.body === "How much?" &&
        storyReply.items[0]?.meta_post_id === "178900000000088" &&
        storyReply.items[0]?.meta_post_permalink == null &&
        storyReply.items[0]?.meta_post_caption == null &&
        (storyReply.items[0]?.attachments?.length ?? 0) === 0
    );

    const storyReferral = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "17841400000000782" },
              timestamp: 1731600001000,
              referral: {
                source: "STORY",
                type: "OPEN_THREAD",
                post_id: "178900000000089",
                source_url: "https://www.instagram.com/stories/gloriousmotors/178900000000089/",
              },
            },
          ],
        },
      ],
    });
    check(
      "STORY referral 記住 story 連結",
      storyReferral.items[0]?.meta_post_id === "178900000000089" &&
        storyReferral.items[0]?.meta_post_permalink ===
          "https://www.instagram.com/stories/gloriousmotors/178900000000089/" &&
        storyReferral.items[0]?.body === "（由帖文開啟私訊）"
    );

    // 2025-11 起嘅 ig_post attachment：media id、title、CDN url。CDN 唔係原帖。
    const sharedPost = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          time: 1761287298065,
          id: "17841400000000001",
          messaging: [
            {
              sender: { id: "17841400000000783" },
              recipient: { id: "17841400000000001" },
              timestamp: 1761287294014,
              message: {
                mid: "aWdfZAG1share",
                text: "How much?",
                attachments: [
                  {
                    type: "share",
                    payload: {
                      ig_post_media_id: "18139494541428835",
                      title: "Build a workspace that attracts talent",
                      url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835",
                    },
                  },
                  {
                    type: "ig_post",
                    payload: {
                      ig_post_media_id: "18139494541428835",
                      title: "白色 Alphard 限量",
                      url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    check(
      "ig_post 分享記住 media id 同 caption，客戶句子同預覽圖分開",
      sharedPost.items.length === 1 &&
        sharedPost.items[0]?.body === "How much?" &&
        sharedPost.items[0]?.meta_post_id === "18139494541428835" &&
        sharedPost.items[0]?.meta_post_caption === "白色 Alphard 限量" &&
        sharedPost.items[0]?.meta_post_permalink == null &&
        (sharedPost.items[0]?.attachments?.length ?? 0) === 0
    );

    const sharedOnly = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "17841400000000784" },
              message: {
                mid: "aWdfZAG1shareonly",
                attachments: [
                  {
                    type: "ig_post",
                    payload: {
                      ig_post_media_id: "178900000000102",
                      title: "只分享帖文",
                      url: "https://www.instagram.com/p/ShareOnly/",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    check(
      "只有 ig_post、冇句子都入庫，caption 唔變成正文",
      sharedOnly.items[0]?.body === "（由帖文開啟私訊）" &&
        sharedOnly.items[0]?.meta_post_caption === "只分享帖文" &&
        sharedOnly.items[0]?.meta_post_permalink === "https://www.instagram.com/p/ShareOnly/" &&
        sharedOnly.items[0]?.meta_post_id === "178900000000102"
    );

    const photoOnly = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "17841400000000785" },
              message: {
                mid: "aWdfZAG1photo",
                attachments: [{ type: "image", payload: { url: "https://cdn.example.com/car.jpg" } }],
              },
            },
          ],
        },
      ],
    });
    check(
      "只有客戶相片仍然係圖片，唔當成帖文",
      photoOnly.items[0]?.body === "［圖片］" &&
        photoOnly.items[0]?.meta_post_id == null &&
        photoOnly.items[0]?.meta_post_caption == null &&
        photoOnly.items[0]?.attachments?.[0]?.kind === "image"
    );

    const shopProduct = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "17841400000000786" },
              message: {
                mid: "aWdfZAG1shop",
                text: "呢件幾多",
                referral: { product: { id: "PRODUCT-900" } },
              },
            },
          ],
        },
      ],
    });
    check(
      "Shop product id 唔當帖文",
      shopProduct.items[0]?.body === "呢件幾多" &&
        shopProduct.items[0]?.meta_post_id == null &&
        shopProduct.items[0]?.meta_post_caption == null
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

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require("express") as typeof import("express");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webhooks = require("../routes/webhooks") as typeof import("../routes/webhooks");
    const hookApp = express();
    hookApp.use(express.json());
    hookApp.use("/api/webhooks/meta", webhooks.metaWebhookRouter);
    const hookServer = await new Promise<import("http").Server>((resolve) => {
      const started = hookApp.listen(0, "127.0.0.1", () => resolve(started));
    });
    const hookAddr = hookServer.address();
    const hookPort = hookAddr && typeof hookAddr === "object" ? hookAddr.port : 0;
    const hookBase = `http://127.0.0.1:${hookPort}/api/webhooks/meta`;
    const originalHookFetch = globalThis.fetch;
    let graphCalls = 0;
    process.env.META_PAGE_ACCESS_TOKEN = "page-token";
    process.env.META_GRAPH_VERSION = "v21.0";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (href.startsWith(hookBase) || href.startsWith("http://127.0.0.1:")) {
        return originalHookFetch(url, init);
      }
      graphCalls += 1;
      if (href.includes("178900000000200")) {
        throw new Error("graph down");
      }
      if (href.includes("178900000000201")) {
        return new Response("nope", { status: 500 });
      }
      if (href.includes("178900000000099")) {
        check(
          "IG 私訊補帖文係 GET media，唔係發私訊",
          href.includes("fields=id%2Ccaption%2Cpermalink") && !href.includes("/messages") && init?.method == null
        );
        return new Response(
          JSON.stringify({
            id: "178900000000099",
            caption: "Graph 補回嘅 IG 帖文",
            permalink: "https://www.instagram.com/p/CxAb12/",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (href.includes("1111111111_2222222222")) {
        return new Response(
          JSON.stringify({
            id: "1111111111_2222222222",
            message: "Graph 補回嘅 Facebook 帖文",
            permalink_url: "https://www.facebook.com/GloriousMotors/posts/2222222222",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    async function postMeta(body: unknown): Promise<{ status: number; json: { ok?: boolean; results?: Array<{ ok?: boolean }> } }> {
      const res = await originalHookFetch(hookBase, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-token": "demo-webhook-token" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; results?: Array<{ ok?: boolean }> };
      return { status: res.status, json };
    }

    try {
      const filled = await postMeta({
        object: "instagram",
        entry: [
          {
            messaging: [
              {
                sender: { id: "17841400000000991" },
                recipient: { id: "17841400000000001" },
                timestamp: 1731600002000,
                message: {
                  mid: "aWdfZAG1graph",
                  text: "How much?",
                  referral: { source: "POST", type: "OPEN_THREAD", post_id: "178900000000099" },
                },
              },
            ],
          },
        ],
      });
      const filledRow = appDb
        .prepare(
          `SELECT body, meta_surface, meta_sender_id, external_id, meta_post_id, meta_post_permalink, meta_post_caption
           FROM comments WHERE external_id = 'aWdfZAG1graph'`
        )
        .get() as {
        body: string;
        meta_surface: string;
        meta_sender_id: string;
        external_id: string;
        meta_post_id: string | null;
        meta_post_permalink: string | null;
        meta_post_caption: string | null;
      };
      check(
        "Webhook：IG 帖文私訊入庫後 Graph 補 caption 同 permalink",
        filled.status === 200 &&
          filled.json.ok === true &&
          filledRow.body === "How much?" &&
          filledRow.meta_surface === "message" &&
          filledRow.meta_post_id === "178900000000099" &&
          filledRow.meta_post_caption === "Graph 補回嘅 IG 帖文" &&
          filledRow.meta_post_permalink === "https://www.instagram.com/p/CxAb12/"
      );
      const dmTarget = graph.resolveMetaReplyTarget({
        channel: "instagram",
        externalId: filledRow.external_id,
        metaSenderId: filledRow.meta_sender_id,
        metaSurface: filledRow.meta_surface,
      });
      check(
        "補帖文之後 IG 回覆仍然係私訊",
        dmTarget.ok && dmTarget.kind === "message" && dmTarget.recipientId === "17841400000000991"
      );

      const thrown = await postMeta({
        object: "instagram",
        entry: [
          {
            messaging: [
              {
                sender: { id: "17841400000000992" },
                message: {
                  mid: "aWdfZAG1graphdown",
                  text: "How much?",
                  referral: { source: "STORY", type: "OPEN_THREAD", post_id: "178900000000200" },
                },
              },
            ],
          },
        ],
      });
      const thrownRow = appDb
        .prepare(
          `SELECT body, meta_surface, meta_post_id, meta_post_caption, meta_post_permalink
           FROM comments WHERE external_id = 'aWdfZAG1graphdown'`
        )
        .get() as {
        body: string;
        meta_surface: string;
        meta_post_id: string | null;
        meta_post_caption: string | null;
        meta_post_permalink: string | null;
      };
      check(
        "Graph 拋錯都入到私訊，帖文編號留低",
        thrown.status === 200 &&
          thrown.json.ok === true &&
          thrownRow.body === "How much?" &&
          thrownRow.meta_surface === "message" &&
          thrownRow.meta_post_id === "178900000000200" &&
          thrownRow.meta_post_caption == null &&
          thrownRow.meta_post_permalink == null
      );

      const httpFail = await postMeta({
        object: "instagram",
        entry: [
          {
            messaging: [
              {
                sender: { id: "17841400000000993" },
                message: {
                  mid: "aWdfZAG1graph500",
                  text: "How much?",
                  referral: { source: "IG_POST", type: "OPEN_THREAD", post_id: "178900000000201" },
                },
              },
            ],
          },
        ],
      });
      const httpFailRow = appDb
        .prepare(`SELECT body, meta_post_id, meta_post_caption FROM comments WHERE external_id = 'aWdfZAG1graph500'`)
        .get() as { body: string; meta_post_id: string | null; meta_post_caption: string | null };
      check(
        "Graph 500 都入到私訊",
        httpFail.status === 200 &&
          httpFail.json.ok === true &&
          httpFailRow.body === "How much?" &&
          httpFailRow.meta_post_id === "178900000000201" &&
          httpFailRow.meta_post_caption == null
      );

      const callsBeforeComplete = graphCalls;
      const complete = await postMeta({
        object: "instagram",
        entry: [
          {
            messaging: [
              {
                sender: { id: "17841400000000994" },
                message: {
                  mid: "aWdfZAG1complete",
                  text: "How much?",
                  referral: {
                    source: "POST",
                    type: "OPEN_THREAD",
                    post_id: "178900000000300",
                    permalink: "https://www.instagram.com/p/Already/",
                    title: "Webhook 已經有 caption",
                  },
                },
              },
            ],
          },
        ],
      });
      const completeRow = appDb
        .prepare(
          `SELECT body, meta_post_caption, meta_post_permalink FROM comments WHERE external_id = 'aWdfZAG1complete'`
        )
        .get() as { body: string; meta_post_caption: string | null; meta_post_permalink: string | null };
      check(
        "permalink 同 caption 齊就唔再打 Graph",
        complete.status === 200 &&
          graphCalls === callsBeforeComplete &&
          completeRow.body === "How much?" &&
          completeRow.meta_post_caption === "Webhook 已經有 caption" &&
          completeRow.meta_post_permalink === "https://www.instagram.com/p/Already/"
      );

      const commentFilled = await postMeta({
        object: "page",
        entry: [
          {
            changes: [
              {
                field: "feed",
                value: {
                  item: "comment",
                  verb: "add",
                  comment_id: "1111111111_2222222222_9009",
                  post_id: "1111111111_2222222222",
                  message: "公開留言都要補",
                  from: { id: "5555000000000099", name: "留言客" },
                },
              },
            ],
          },
        ],
      });
      const commentRow = appDb
        .prepare(
          `SELECT meta_surface, meta_post_caption, meta_post_permalink, external_id
           FROM comments WHERE external_id = '1111111111_2222222222_9009'`
        )
        .get() as {
        meta_surface: string;
        meta_post_caption: string | null;
        meta_post_permalink: string | null;
        external_id: string;
      };
      check(
        "公開留言補帖文路徑仍然打 comment",
        commentFilled.status === 200 &&
          commentRow.meta_surface === "comment" &&
          commentRow.meta_post_caption === "Graph 補回嘅 Facebook 帖文" &&
          commentRow.meta_post_permalink === "https://www.facebook.com/GloriousMotors/posts/2222222222" &&
          commentRow.external_id === "1111111111_2222222222_9009"
      );
    } finally {
      globalThis.fetch = originalHookFetch;
      delete process.env.META_PAGE_ACCESS_TOKEN;
      delete process.env.META_GRAPH_VERSION;
      await new Promise<void>((resolve, reject) => {
        hookServer.close((err) => (err ? reject(err) : resolve()));
      });
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
