/**
 * 2026-11-23 Ferrari 360 Challenge Stradale Reel 強制派畀 Ken。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 *
 * 涵蓋：FB 留言（composite）、FB 留言（Reel id）、IG 留言（media id）、
 * IG 留言（只有 shortcode permalink）、IG 私訊（ig_id）、Messenger（Reel id）、
 * WhatsApp click（FB composite 同 IG media id）、另一條帖文仍然輪流、
 * Ken 暫停自動派單仍然收到呢條 Reel、已完成唔會被一次過改派重開、
 * 跟進保持原有重開規則。
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

const FB_COMPOSITE = "317388328327472_1645104830962403";
const FB_STORY = "1645104830962403";
const FB_REEL = "1152546584163003";
const IG_MEDIA = "17954673084307814";
const IG_ID = "4036657255367133420";
const SHORTCODE = "DgFFmL6KUjs";
const FB_REEL_URL = "https://www.facebook.com/reel/1152546584163003/";
const IG_REEL_URL = "https://www.instagram.com/reel/DgFFmL6KUjs/";
const OTHER_POST = "1111111111_2222222222";
const OTHER_REEL = "1325272579671228";
const KEN_HASH = "kept-ken-hash";
const SLA_FROM = "2026-11-20 00:00:00";
const SLA_UNTIL = "2999-01-01 00:00:00";
const SLA_UPDATED = "2026-11-20 00:00:00";

interface CursorRow {
  last_staff_id: number | null;
  last_username: string | null;
  version: number;
}

interface SlaRow {
  delay_count: number;
  suspended_from: string | null;
  suspended_until: string | null;
  suspensions_started: number;
  updated_at: string;
}

function usernameOf(appDb: Database.Database, staffId: number | null): string | null {
  if (staffId == null) return null;
  const row = appDb.prepare(`SELECT username FROM staff WHERE id = ?`).get(staffId) as
    | { username: string }
    | undefined;
  return row?.username ?? null;
}

function cursorOf(appDb: Database.Database): CursorRow | undefined {
  return appDb.prepare(`SELECT last_staff_id, last_username, version FROM auto_assign_state WHERE id = 1`).get() as
    | CursorRow
    | undefined;
}

function slaOf(appDb: Database.Database, staffId: number): SlaRow | undefined {
  return appDb
    .prepare(
      `SELECT delay_count, suspended_from, suspended_until, suspensions_started, updated_at
       FROM staff_reply_sla WHERE staff_id = ?`
    )
    .get(staffId) as SlaRow | undefined;
}

function stored(appDb: Database.Database, source: string, externalId: string): {
  id: number;
  status: string;
  assignee_staff_id: number | null;
  body: string;
  meta_post_id: string | null;
  meta_post_permalink: string | null;
  meta_post_caption: string | null;
} {
  return appDb
    .prepare(
      `SELECT id, status, assignee_staff_id, body, meta_post_id, meta_post_permalink, meta_post_caption
       FROM comments WHERE source = ? AND external_id = ?`
    )
    .get(source, externalId) as {
    id: number;
    status: string;
    assignee_staff_id: number | null;
    body: string;
    meta_post_id: string | null;
    meta_post_permalink: string | null;
    meta_post_caption: string | null;
  };
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-source-assign-"));
  const dbFile = path.join(tmp, "inbox.db");
  let appDb: Database.Database | undefined;

  try {
    process.env.INBOX_DB = "sqlite";
    process.env.DATABASE_PATH = dbFile;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.META_APP_SECRET;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as typeof import("../db");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const site = require("../services/site-comments") as typeof import("../services/site-comments");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const meta = require("../services/meta-webhook") as typeof import("../services/meta-webhook");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wa = require("../services/whatsapp") as typeof import("../services/whatsapp");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sourceAssign = require("../services/source-assign") as typeof import("../services/source-assign");
    appDb = dbMod.db;

    appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active) VALUES
           ('eddie', 'Eddie Lau', 'x', 1, 1),
           ('wing', 'Wing Cheng', 'x', 0, 1),
           ('jason', 'Jason Cheng', 'x', 0, 1),
           ('tony', 'Tony Chan', 'x', 1, 1),
           ('benjamin', 'Benjamin', 'x', 1, 1),
           ('vivian', 'Vivian', 'x', 1, 1),
           ('ken', 'Ken Kan', ?, 0, 1),
           ('raymond', 'Raymond Chan', 'x', 1, 1)`
      )
      .run(KEN_HASH);
    const idOf = (username: string) =>
      (appDb!.prepare(`SELECT id FROM staff WHERE username = ?`).get(username) as { id: number }).id;
    const eddieId = idOf("eddie");
    const wingId = idOf("wing");
    const jasonId = idOf("jason");
    const kenId = idOf("ken");

    appDb
      .prepare(
        `INSERT INTO staff_reply_sla (
           staff_id, delay_count, suspended_from, suspended_until, suspensions_started, updated_at
         ) VALUES (?, 2, ?, ?, 1, ?)`
      )
      .run(kenId, SLA_FROM, SLA_UNTIL, SLA_UPDATED);
    const slaBefore = slaOf(appDb, kenId);

    const insert = appDb.prepare(
      `INSERT INTO comments (
         source, external_id, author_name, body, status, assignee_staff_id,
         intake_kind, origin_site, meta_surface, meta_post_id, meta_post_permalink, meta_post_caption
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      "facebook",
      "hist-open-composite",
      "歷史甲",
      "歷史留言",
      "open",
      eddieId,
      "site_comment",
      null,
      "comment",
      FB_COMPOSITE,
      FB_REEL_URL,
      "已核對，唔好改"
    );
    insert.run(
      "instagram",
      "hist-ig-link",
      "歷史乙",
      "歷史 IG",
      "in_progress",
      wingId,
      "site_comment",
      null,
      "comment",
      null,
      `${IG_REEL_URL}?igsh=tracking`,
      "IG caption"
    );
    insert.run(
      "facebook",
      "hist-done",
      "歷史丙",
      "已完成",
      "done",
      jasonId,
      "site_comment",
      null,
      "comment",
      FB_REEL,
      FB_REEL_URL,
      "done caption"
    );
    insert.run(
      "facebook",
      "hist-other",
      "歷史丁",
      "其他帖",
      "open",
      eddieId,
      "site_comment",
      null,
      "comment",
      OTHER_POST,
      "https://www.facebook.com/GloriousMotors/posts/2222222222",
      "Ferrari 360 Challenge Stradale Rosso"
    );
    insert.run(
      "whatsapp",
      "hist-wa",
      "歷史戊",
      "歷史 WA",
      "open",
      jasonId,
      "whatsapp_click",
      "instagram",
      null,
      IG_MEDIA,
      IG_REEL_URL,
      "WA caption"
    );
    insert.run(
      "facebook",
      "hist-done-same",
      "歷史完成甲",
      "幾多錢",
      "done",
      eddieId,
      "site_comment",
      null,
      "comment",
      FB_COMPOSITE,
      FB_REEL_URL,
      "完成 caption"
    );
    insert.run(
      "facebook",
      "hist-done-reopen",
      "歷史完成乙",
      "幾多錢",
      "done",
      eddieId,
      "site_comment",
      null,
      "comment",
      FB_COMPOSITE,
      null,
      "重開 caption"
    );

    const once = sourceAssign.assignPinnedSourceThreadsOnce();
    const openComposite = stored(appDb, "facebook", "hist-open-composite");
    const igLink = stored(appDb, "instagram", "hist-ig-link");
    const doneRow = stored(appDb, "facebook", "hist-done");
    const otherRow = stored(appDb, "facebook", "hist-other");
    const waHist = stored(appDb, "whatsapp", "hist-wa");
    check(
      "一次過把未完成的 composite、shortcode、IG media 改派畀 Ken",
      once.applied === true &&
        once.reassigned === 3 &&
        once.already === 0 &&
        openComposite.assignee_staff_id === kenId &&
        openComposite.status === "open" &&
        openComposite.body === "歷史留言" &&
        openComposite.meta_post_caption === "已核對，唔好改" &&
        igLink.assignee_staff_id === kenId &&
        igLink.status === "in_progress" &&
        igLink.body === "歷史 IG" &&
        igLink.meta_post_caption === "IG caption" &&
        waHist.assignee_staff_id === kenId &&
        waHist.body === "歷史 WA" &&
        waHist.meta_post_caption === "WA caption"
    );
    check(
      "一次過唔改已完成，亦唔改其他帖（即使 caption 有 360／Rosso）",
      doneRow.status === "done" &&
        doneRow.assignee_staff_id === jasonId &&
        doneRow.body === "已完成" &&
        doneRow.meta_post_caption === "done caption" &&
        otherRow.status === "open" &&
        otherRow.assignee_staff_id === eddieId &&
        otherRow.body === "其他帖" &&
        otherRow.meta_post_caption === "Ferrari 360 Challenge Stradale Rosso"
    );
    check(
      "一次過唔改 Ken 的逾時暫停",
      slaOf(appDb, kenId)?.delay_count === slaBefore?.delay_count &&
        slaOf(appDb, kenId)?.suspended_until === SLA_UNTIL &&
        slaOf(appDb, kenId)?.suspensions_started === 1 &&
        slaOf(appDb, kenId)?.updated_at === SLA_UPDATED
    );

    wa.ensureCompanyWhatsAppLine();
    appDb.prepare(`DELETE FROM auto_assign_state`).run();

    const unrelated = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "other-post-1",
                post_id: OTHER_POST,
                message: "呢部又有 360 字",
                from: { id: "cust-other", name: "其他客" },
                post: {
                  id: OTHER_POST,
                  permalink_url: "https://www.facebook.com/GloriousMotors/posts/2222222222",
                  message: "Ferrari 360 Challenge Stradale Rosso 另一條帖",
                },
              },
            },
          ],
        },
      ],
    });
    const storedOther = site.upsertSiteComment(unrelated.items[0]!);
    const afterOther = cursorOf(appDb);
    check(
      "另一條帖文仍然公司輪流，第一位係 Eddie，唔係 Ken 或管理員",
      storedOther.ok &&
        storedOther.assigneeStaffId === eddieId &&
        usernameOf(appDb, storedOther.assigneeStaffId) === "eddie" &&
        afterOther?.last_username === "eddie" &&
        afterOther.version === 1 &&
        storedOther.comment.meta_post_caption === "Ferrari 360 Challenge Stradale Rosso 另一條帖"
    );

    const fbComposite = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "fb-composite-1",
                post_id: FB_COMPOSITE,
                message: "想問 Ferrari",
                from: { id: "cust-fb-1", name: "FB 留言客" },
                post: {
                  id: FB_COMPOSITE,
                  permalink_url: FB_REEL_URL,
                  message: "唔好用 caption 做規則",
                },
              },
            },
          ],
        },
      ],
    });
    const storedFb = site.upsertSiteComment(fbComposite.items[0]!);
    check(
      "Facebook 留言 composite post id 派畀 Ken，游標唔推進",
      fbComposite.items[0]?.meta_post_id === FB_COMPOSITE &&
        storedFb.ok &&
        storedFb.created === true &&
        storedFb.assigneeStaffId === kenId &&
        storedFb.comment.meta_surface === "comment" &&
        storedFb.comment.body === "想問 Ferrari" &&
        cursorOf(appDb)?.version === 1 &&
        cursorOf(appDb)?.last_username === "eddie"
    );

    const fbReel = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "fb-reel-id-1",
                post_id: FB_REEL,
                message: "Reel 留言",
                from: { id: "cust-fb-reel", name: "Reel 留言客" },
                post: { permalink_url: FB_REEL_URL },
              },
            },
          ],
        },
      ],
    });
    const storedFbReel = site.upsertSiteComment(fbReel.items[0]!);
    check(
      "Facebook 留言用 Reel／video id 而唔係 composite，仍然派畀 Ken",
      fbReel.items[0]?.meta_post_id === FB_REEL &&
        storedFbReel.ok &&
        storedFbReel.assigneeStaffId === kenId &&
        cursorOf(appDb)?.version === 1
    );

    const igMedia = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          changes: [
            {
              field: "comments",
              value: {
                id: "ig-media-1",
                text: "IG 留言",
                from: { id: "cust-ig-1", username: "ig_buyer" },
                media: {
                  id: IG_MEDIA,
                  media_product_type: "REELS",
                  media_type: "VIDEO",
                  permalink: IG_REEL_URL,
                },
              },
            },
          ],
        },
      ],
    });
    const storedIg = site.upsertSiteComment(igMedia.items[0]!);
    check(
      "Instagram 留言 media id 派畀 Ken",
      igMedia.items[0]?.meta_post_id === IG_MEDIA &&
        storedIg.ok &&
        storedIg.comment.source === "instagram" &&
        storedIg.comment.meta_surface === "comment" &&
        storedIg.assigneeStaffId === kenId &&
        cursorOf(appDb)?.version === 1
    );

    const igShort = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          changes: [
            {
              field: "comments",
              value: {
                id: "ig-shortcode-1",
                text: "只有 shortcode",
                from: { id: "cust-ig-short", username: "short_buyer" },
                media: {
                  media_product_type: "REELS",
                  permalink: IG_REEL_URL,
                },
              },
            },
          ],
        },
      ],
    });
    const storedShort = site.upsertSiteComment(igShort.items[0]!);
    check(
      "Instagram 留言只有 Reel shortcode permalink 都派畀 Ken",
      igShort.items[0]?.meta_post_id == null &&
        igShort.items[0]?.meta_post_permalink === IG_REEL_URL &&
        storedShort.ok &&
        storedShort.assigneeStaffId === kenId &&
        cursorOf(appDb)?.version === 1
    );

    const igDm = meta.parseMetaWebhookPayload({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "cust-ig-dm" },
              recipient: { id: "17841400000000001" },
              timestamp: 1731600001000,
              message: {
                mid: "ig-dm-ferrari",
                text: "幾多錢",
                referral: {
                  source: "REEL",
                  type: "OPEN_THREAD",
                  post_id: IG_ID,
                },
              },
            },
          ],
        },
      ],
    });
    const storedIgDm = site.upsertSiteComment(igDm.items[0]!);
    check(
      "Instagram 私訊用 ig_id 派畀 Ken，客戶句子保留",
      igDm.items[0]?.meta_surface === "message" &&
        igDm.items[0]?.meta_post_id === IG_ID &&
        igDm.items[0]?.body === "幾多錢" &&
        storedIgDm.ok &&
        storedIgDm.assigneeStaffId === kenId &&
        storedIgDm.comment.body === "幾多錢" &&
        cursorOf(appDb)?.version === 1
    );

    const fbDm = meta.parseMetaWebhookPayload({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "cust-fb-dm", name: "Messenger 客" },
              recipient: { id: "317388328327472" },
              message: {
                mid: "fb-dm-ferrari",
                text: "這架怎樣？",
                referral: {
                  source: "REEL",
                  type: "OPEN_THREAD",
                  post_id: FB_REEL,
                  source_url: FB_REEL_URL,
                },
              },
            },
          ],
        },
      ],
    });
    const storedFbDm = site.upsertSiteComment(fbDm.items[0]!);
    check(
      "Facebook Messenger 由呢條 Reel 私訊派畀 Ken",
      fbDm.items[0]?.meta_surface === "message" &&
        fbDm.items[0]?.meta_post_id === FB_REEL &&
        fbDm.items[0]?.meta_post_permalink === FB_REEL_URL &&
        fbDm.items[0]?.body === "這架怎樣？" &&
        storedFbDm.ok &&
        storedFbDm.assigneeStaffId === kenId &&
        cursorOf(appDb)?.version === 1
    );

    const waFb = wa.parseWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { display_phone_number: COMPANY_WHATSAPP_PHONE },
                contacts: [{ profile: { name: "WA FB" }, wa_id: "85293330001" }],
                messages: [
                  {
                    from: "85293330001",
                    id: "wamid.FERRARI-FB",
                    timestamp: "1749416383",
                    type: "text",
                    text: { body: "想問呢條 FB Reel" },
                    referral: {
                      source_type: "post",
                      source_id: FB_COMPOSITE,
                      source_url: FB_REEL_URL,
                      headline: "Ferrari 360",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const routedWaFb = waFb.messages[0] ? wa.routeWhatsAppInbound(waFb.messages[0]) : null;
    const waFbRow = stored(appDb, "whatsapp", "wamid.FERRARI-FB");
    check(
      "WhatsApp click 帶 Facebook Reel composite 派畀 Ken，句子唔係 headline",
      !!routedWaFb?.ok &&
        routedWaFb.created === true &&
        routedWaFb.assigneeStaffId === kenId &&
        waFbRow?.body === "想問呢條 FB Reel" &&
        waFbRow.meta_post_id === FB_COMPOSITE &&
        waFbRow.meta_post_permalink === FB_REEL_URL &&
        waFbRow.meta_post_caption === "Ferrari 360" &&
        cursorOf(appDb)?.version === 1
    );

    const waIg = wa.parseWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { display_phone_number: COMPANY_WHATSAPP_PHONE },
                contacts: [{ profile: { name: "WA IG" }, wa_id: "85293330002" }],
                messages: [
                  {
                    from: "85293330002",
                    id: "wamid.FERRARI-IG",
                    timestamp: "1749416383",
                    type: "text",
                    text: { body: "想問呢條 IG Reel" },
                    referral: {
                      source_type: "ad",
                      source_id: IG_MEDIA,
                      source_url: IG_REEL_URL,
                      headline: "360",
                      body: "Rosso",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const routedWaIg = waIg.messages[0] ? wa.routeWhatsAppInbound(waIg.messages[0]) : null;
    const waIgRow = stored(appDb, "whatsapp", "wamid.FERRARI-IG");
    check(
      "WhatsApp click 帶 Instagram media id 派畀 Ken",
      !!routedWaIg?.ok &&
        routedWaIg.assigneeStaffId === kenId &&
        waIgRow?.meta_post_id === IG_MEDIA &&
        waIgRow.meta_post_permalink === IG_REEL_URL &&
        waIgRow.body === "想問呢條 IG Reel" &&
        cursorOf(appDb)?.version === 1
    );

    const pageVideo = site.upsertSiteComment({
      source: "facebook",
      external_id: "fb-page-video",
      author_name: "頁加影片 id",
      body: "page_video",
      meta_sender_id: "cust-page-video",
      meta_surface: "comment",
      meta_post_id: `317388328327472_${FB_REEL}`,
      meta_post_permalink: `https://www.facebook.com/videos/${FB_REEL}/`,
    });
    const storyLink = site.upsertSiteComment({
      source: "facebook",
      external_id: "fb-story-fbid",
      author_name: "story fbid",
      body: "story",
      meta_sender_id: "cust-story",
      meta_surface: "message",
      meta_post_permalink: `https://www.facebook.com/permalink.php?story_fbid=${FB_STORY}&id=317388328327472`,
    });
    check(
      "專頁 id 加 Reel id，同 story_fbid permalink，都派畀 Ken",
      pageVideo.ok &&
        pageVideo.assigneeStaffId === kenId &&
        storyLink.ok &&
        storyLink.assigneeStaffId === kenId &&
        cursorOf(appDb)?.version === 1
    );

    const secondOther = site.upsertSiteComment({
      source: "facebook",
      external_id: "other-post-2",
      author_name: "下一輪",
      body: "普通帖",
      meta_sender_id: "cust-other-2",
      meta_surface: "comment",
      meta_post_id: OTHER_REEL,
      meta_post_permalink: `https://www.facebook.com/reel/${OTHER_REEL}/`,
      meta_post_caption: "360 Rosso",
    });
    check(
      "指定來源之後，下一則其他帖文接 Eddie 的下一位 Wing",
      secondOther.ok &&
        secondOther.assigneeStaffId === wingId &&
        cursorOf(appDb)?.last_username === "wing" &&
        cursorOf(appDb)?.version === 2
    );
    const thirdOther = site.upsertSiteComment({
      source: "instagram",
      external_id: "other-post-3",
      author_name: "再下一輪",
      body: "普通 IG",
      meta_sender_id: "cust-other-3",
      meta_surface: "comment",
      meta_post_id: "178900000000099",
      meta_post_permalink: "https://www.instagram.com/p/NotThisReel/",
    });
    const fourthOther = site.upsertSiteComment({
      source: "facebook",
      external_id: "other-post-4",
      author_name: "跳過 Ken",
      body: "Ken 暫停所以輪到 Eddie",
      meta_sender_id: "cust-other-4",
      meta_surface: "comment",
      meta_post_id: "5555555555_6666666666",
    });
    check(
      "Ken 暫停自動派單時，輪流跳過佢，但唔清暫停",
      thirdOther.ok &&
        thirdOther.assigneeStaffId === jasonId &&
        fourthOther.ok &&
        fourthOther.assigneeStaffId === eddieId &&
        usernameOf(appDb, fourthOther.assigneeStaffId) !== "tony" &&
        usernameOf(appDb, fourthOther.assigneeStaffId) !== "ken" &&
        slaOf(appDb, kenId)?.delay_count === 2 &&
        slaOf(appDb, kenId)?.suspended_from === SLA_FROM &&
        slaOf(appDb, kenId)?.suspended_until === SLA_UNTIL &&
        slaOf(appDb, kenId)?.suspensions_started === 1 &&
        slaOf(appDb, kenId)?.updated_at === SLA_UPDATED
    );

    const duringPause = site.upsertSiteComment({
      source: "instagram",
      external_id: "ig-during-pause",
      author_name: "暫停期間",
      body: "仍然 Ken",
      meta_sender_id: "cust-pause",
      meta_surface: "comment",
      meta_post_id: IG_MEDIA,
      meta_post_permalink: `https://www.instagram.com/p/${SHORTCODE}/`,
    });
    check(
      "Ken 暫停期間，呢條 Reel 仍然派畀佢，暫停紀錄唔變，游標停喺跳過佢之前",
      duringPause.ok &&
        duringPause.assigneeStaffId === kenId &&
        cursorOf(appDb)?.last_username === "eddie" &&
        cursorOf(appDb)?.version === 4 &&
        slaOf(appDb, kenId)?.suspended_until === SLA_UNTIL &&
        slaOf(appDb, kenId)?.delay_count === 2
    );

    appDb
      .prepare(
        `INSERT INTO whatsapp_lines (phone_e164, display_label, kind, staff_id, is_active)
         VALUES ('85261110001', 'Wing 私人', 'staff', ?, 1)`
      )
      .run(wingId);
    const personal = wa.routeWhatsAppInbound({
      toPhone: "85261110001",
      fromPhone: "85294440009",
      body: "打去同事私人號",
      externalId: "wamid.PERSONAL-REEL",
      authorName: "私人客",
      originSite: "facebook",
      metaPostId: FB_REEL,
      metaPostPermalink: FB_REEL_URL,
      metaPostCaption: "Ferrari 360",
    });
    check(
      "同事個人 WhatsApp 即使帶呢條 Reel，仍然派畀該同事",
      personal.ok && personal.assigneeStaffId === wingId && cursorOf(appDb)?.version === 4
    );

    const sameDone = site.upsertSiteComment({
      source: "facebook",
      external_id: "hist-done-same",
      author_name: "歷史完成甲",
      body: "幾多錢",
      meta_post_id: FB_COMPOSITE,
      meta_post_permalink: FB_REEL_URL,
      meta_surface: "comment",
    });
    const sameDoneRow = stored(appDb, "facebook", "hist-done-same");
    check(
      "已完成跟進如果內容冇變，保持已完成同原負責人",
      sameDone.ok &&
        sameDone.created === false &&
        sameDoneRow.status === "done" &&
        sameDoneRow.assignee_staff_id === eddieId &&
        sameDoneRow.body === "幾多錢" &&
        sameDoneRow.meta_post_caption === "完成 caption"
    );

    const reopened = site.upsertSiteComment({
      source: "facebook",
      external_id: "hist-done-reopen",
      author_name: "歷史完成乙",
      body: "幾多錢，可唔可以睇車",
      meta_post_id: FB_COMPOSITE,
      meta_surface: "comment",
      meta_sender_id: "cust-reopen",
    });
    const reopenedRow = stored(appDb, "facebook", "hist-done-reopen");
    check(
      "已完成跟進如果產品本身會重開，重開之後派畀 Ken，caption 保留",
      reopened.ok &&
        reopenedRow.status === "open" &&
        reopenedRow.assignee_staff_id === kenId &&
        reopenedRow.body === "幾多錢，可唔可以睇車" &&
        reopenedRow.meta_post_caption === "重開 caption"
    );

    appDb.prepare(`UPDATE comments SET assignee_staff_id = ? WHERE external_id = 'hist-open-composite'`).run(eddieId);
    const secondOnce = sourceAssign.assignPinnedSourceThreadsOnce();
    const movedBack = stored(appDb, "facebook", "hist-open-composite");
    check(
      "boot 標記寫入之後唔會再改派",
      secondOnce.applied === false &&
        secondOnce.reassigned === 0 &&
        movedBack.assignee_staff_id === eddieId &&
        movedBack.status === "open"
    );

    const kenRow = appDb.prepare(`SELECT is_admin, active, password_hash FROM staff WHERE username = 'ken'`).get() as {
      is_admin: number;
      active: number;
      password_hash: string;
    };
    check(
      "Ken 仍然係在職同事，密碼同角色冇改",
      kenRow.is_admin === 0 && kenRow.active === 1 && kenRow.password_hash === KEN_HASH
    );

    const match = sourceAssign.matchesPinnedSourcePost;
    check(
      "編號對照涵蓋 composite、story_fbid、Reel id、IG media、ig_id、shortcode",
      match(FB_COMPOSITE, null) &&
        match(FB_STORY, null) &&
        match(FB_REEL, null) &&
        match(IG_MEDIA, null) &&
        match(IG_ID, null) &&
        match(SHORTCODE, null) &&
        match(`317388328327472_${FB_REEL}`, null) &&
        match(null, FB_REEL_URL) &&
        match(null, `${IG_REEL_URL}?igsh=1`) &&
        match(null, `https://www.instagram.com/p/${SHORTCODE}/`) &&
        match(null, `https://www.instagram.com/reels/${SHORTCODE}`) &&
        match(null, `https://m.facebook.com/reel/${FB_REEL}`) &&
        match(null, `https://www.facebook.com/watch/?v=${FB_REEL}`) &&
        match(null, `https://www.facebook.com/permalink.php?story_fbid=${FB_STORY}&id=317388328327472`) &&
        match(null, `https://www.facebook.com/317388328327472/posts/${FB_STORY}`)
    );
    check(
      "其他帖文、專頁 id、近似編號同短碼前綴唔當係呢條 Reel",
      !match(OTHER_POST, null) &&
        !match(OTHER_REEL, `https://www.facebook.com/reel/${OTHER_REEL}/`) &&
        !match("317388328327472", null) &&
        !match(`${FB_REEL}0`, null) &&
        !match(`${SHORTCODE}x`, null) &&
        !match(null, "https://example.com/reel/DgFFmL6KUjs/") &&
        !match(null, "javascript:alert(1)") &&
        !match(null, null)
    );

    const pinnedNames = appDb
      .prepare(
        `SELECT s.username AS username
         FROM comments c
         JOIN staff s ON s.id = c.assignee_staff_id
         WHERE c.external_id IN (
           'fb-composite-1', 'fb-reel-id-1', 'ig-media-1', 'ig-shortcode-1',
           'ig-dm-ferrari', 'fb-dm-ferrari', 'wamid.FERRARI-FB', 'wamid.FERRARI-IG',
           'fb-page-video', 'fb-story-fbid', 'ig-during-pause'
         )`
      )
      .all() as Array<{ username: string }>;
    check(
      "新入站的呢條 Reel 全部係 Ken，管理員冇接到",
      pinnedNames.length === 11 && pinnedNames.every((row) => row.username === "ken")
    );

    if (failures.length) {
      console.error(`\n${failures.length} 項失敗`);
      return 1;
    }
    console.log("\n指定帖文派單示範通過");
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
