/**
 * 回覆時限：香港星期同夜晚窗、逾時只記一次、三次暫停、
 * 七日後自動回到公司線輪流（包括暫停中途重啟），管理員只通知一次。
 * 用臨時 SQLite，唔會郁到正式 data/inbox.db。
 */
import { spawnSync } from "child_process";
import fs from "fs";
import type { Server } from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { REPLY_SLA_START_UTC, REPLY_SLA_SUSPEND_MS } from "../reply-sla-config";
import { computeReplyDeadline, formatUtcTimestamp } from "../services/reply-sla-clock";
import { parseStoredTimestamp } from "../time";

const failures: string[] = [];
const DEMO_PASSWORD = "Glorious2026!";
const T_IN = "2026-11-17 01:00:00";
const T_DUE = "2026-11-17 03:00:00";
const T_LATE = "2026-11-17 06:00:00";
const T_ON_TIME = "2026-11-17 02:00:00";
const PAST = "2000-01-01 00:00:00";
const FUTURE = "2999-01-01 00:00:00";

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.error(`FAIL ${line}`);
    return;
  }
  console.log(`OK   ${name}`);
}

function atHkt(wall: string): Date {
  const instant = parseStoredTimestamp(wall, "hkt");
  if (!instant) throw new Error(wall);
  return instant;
}

function deadlineOf(wall: string): { due: string; start: string; limit: number } {
  const deadline = computeReplyDeadline(atHkt(wall));
  return {
    due: formatUtcTimestamp(deadline.due),
    start: formatUtcTimestamp(deadline.countStart),
    limit: deadline.limitSeconds,
  };
}

function clockCases(): void {
  const start = parseStoredTimestamp("2026-11-17 00:00:00", "hkt");
  check(
    "規則由 2026-11-17 00:00 香港時間開始，資料庫用 UTC",
    start != null && formatUtcTimestamp(start) === REPLY_SLA_START_UTC && REPLY_SLA_START_UTC === "2026-11-16 16:00:00"
  );

  const satEarly = deadlineOf("2026-11-14 22:00:00");
  check(
    "星期六 22:00 用 2 小時，23:00 暫停，星期日 10:00 到期",
    satEarly.limit === 7200 &&
      satEarly.start === "2026-11-14 14:00:00" &&
      satEarly.due === "2026-11-15 02:00:00",
    JSON.stringify(satEarly)
  );

  const satNight = deadlineOf("2026-11-14 23:30:00");
  check(
    "星期六 23:30 由星期日 09:00 先計，用星期日 3 小時，12:00 到期",
    satNight.limit === 10800 &&
      satNight.start === "2026-11-15 01:00:00" &&
      satNight.due === "2026-11-15 04:00:00",
    JSON.stringify(satNight)
  );

  const sunNight = deadlineOf("2026-11-15 23:30:00");
  check(
    "星期日 23:30 由星期一 09:00 先計，用星期一 2 小時，11:00 到期",
    sunNight.limit === 7200 &&
      sunNight.start === "2026-11-16 01:00:00" &&
      sunNight.due === "2026-11-16 03:00:00",
    JSON.stringify(sunNight)
  );

  const sat2300 = deadlineOf("2026-11-14 23:00:00");
  check(
    "正正 23:00 已經係夜晚窗，星期六 23:00 當星期日 3 小時",
    sat2300.limit === 10800 && sat2300.start === "2026-11-15 01:00:00" && sat2300.due === "2026-11-15 04:00:00"
  );

  const sun0900 = deadlineOf("2026-11-15 09:00:00");
  check(
    "正正 09:00 開始計，星期日 09:00 用 3 小時",
    sun0900.limit === 10800 && sun0900.start === "2026-11-15 01:00:00" && sun0900.due === "2026-11-15 04:00:00"
  );

  const sun0859 = deadlineOf("2026-11-15 08:59:59");
  check(
    "09:00 之前仍係夜晚窗",
    sun0859.start === "2026-11-15 01:00:00" && sun0859.limit === 10800
  );

  const fri = deadlineOf("2026-11-13 22:30:00");
  check(
    "星期五 22:30 用星期五 2 小時，跨到星期六 10:30",
    fri.limit === 7200 && fri.start === "2026-11-13 14:30:00" && fri.due === "2026-11-14 02:30:00",
    JSON.stringify(fri)
  );

  const sun2200 = deadlineOf("2026-11-15 22:00:00");
  check(
    "星期日 22:00 用 3 小時，跨到星期一 11:00",
    sun2200.limit === 10800 && sun2200.due === "2026-11-16 03:00:00",
    JSON.stringify(sun2200)
  );

  const mon = deadlineOf("2026-11-16 10:00:00");
  check("星期一 10:00 兩小時後到期", mon.limit === 7200 && mon.due === "2026-11-16 04:00:00");

  const yearEnd = deadlineOf("2026-12-31 23:30:00");
  check(
    "跨年夜晚窗由下一日 09:00 再計",
    yearEnd.start === "2027-01-01 01:00:00" && yearEnd.limit === 7200 && yearEnd.due === "2027-01-01 03:00:00",
    JSON.stringify(yearEnd)
  );
}

function cookieHeader(res: Response): string {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return raw
    .map((item) => item.split(";")[0])
    .filter((item) => item.startsWith("connect.sid="))
    .join("; ");
}

async function dbCases(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glorious-sla-"));
  const dbFile = path.join(tmp, "inbox.db");
  process.env.INBOX_DB = "sqlite";
  process.env.DATABASE_PATH = dbFile;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dbMod = require("../db") as typeof import("../db");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const passwords = require("../auth/passwords") as typeof import("../auth/passwords");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const assignMod = require("../services/assign") as typeof import("../services/assign");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const slaMod = require("../services/reply-sla") as typeof import("../services/reply-sla");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const repliesMod = require("../services/replies") as typeof import("../services/replies");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const session = require("express-session") as typeof import("express-session");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const apiRoutes = require("../routes/api") as typeof import("../routes/api");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pageRoutes = require("../routes/pages") as typeof import("../routes/pages");

  const appDb = dbMod.db;
  const pushes: Array<{ staffIds: number[]; body: string; url: string }> = [];
  slaMod.setReplySlaPush((input) => {
    pushes.push({ staffIds: [...input.staffIds], body: input.body, url: input.url });
  });

  const hash = passwords.hashPassword(DEMO_PASSWORD);
  const ids = new Map<string, number>();
  const people: Array<[string, string, number]> = [
    ["eddie", "Eddie Lau", 1],
    ["wing", "Wing Cheng", 0],
    ["jason", "Jason Cheng", 0],
    ["sam", "Sam Ho", 0],
    ["tony", "Tony Chan", 1],
    ["benjamin", "Benjamin", 1],
    ["vivian", "Vivian", 1],
    ["ken", "Ken Kan", 1],
  ];
  for (const [username, displayName, isAdmin] of people) {
    const info = appDb
      .prepare(
        `INSERT INTO staff (username, display_name, password_hash, is_admin, active)
         VALUES (?, ?, ?, ?, 1)`
      )
      .run(username, displayName, hash, isAdmin);
    ids.set(username, Number(info.lastInsertRowid));
  }
  const idOf = (name: string) => {
    const id = ids.get(name);
    if (!id) throw new Error(name);
    return id;
  };

  let seq = 0;
  const addComment = (assignee: number | null, createdAt: string) => {
    seq += 1;
    const info = appDb
      .prepare(
        `INSERT INTO comments (
           source, external_id, author_name, body, status, assignee_staff_id, intake_kind, created_at, updated_at
         ) VALUES ('28car', ?, '陳先生', '想問價', 'open', ?, 'site_comment', ?, ?)`
      )
      .run(`sla-${seq}`, assignee, createdAt, createdAt);
    return Number(info.lastInsertRowid);
  };
  const addOutbound = (commentId: number, staffId: number, createdAt: string) => {
    const info = appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, ?, 'outbound', '已回覆', 'stored', ?)`
      )
      .run(commentId, staffId, createdAt);
    return Number(info.lastInsertRowid);
  };
  const addInbound = (commentId: number, createdAt: string) => {
    const info = appDb
      .prepare(
        `INSERT INTO comment_replies (comment_id, staff_id, direction, body, delivery_status, created_at)
         VALUES (?, NULL, 'inbound', '再問多句', 'stored', ?)`
      )
      .run(commentId, createdAt);
    return Number(info.lastInsertRowid);
  };
  const stateOf = (staffId: number) => {
    const staff = appDb.prepare(`SELECT active FROM staff WHERE id = ?`).get(staffId) as { active: number };
    const row = appDb
      .prepare(`SELECT delay_count, suspended_until FROM staff_reply_sla WHERE staff_id = ?`)
      .get(staffId) as { delay_count: number; suspended_until: string | null } | undefined;
    return {
      delay_count: row ? Number(row.delay_count) : 0,
      suspended_until: row?.suspended_until ?? null,
      active: Number(staff.active),
    };
  };
  const opening = (commentId: number) =>
    appDb
      .prepare(
        `SELECT due_at, count_start_at, limit_seconds, met_at, delay_staff_id, delay_recorded_at
         FROM reply_sla WHERE comment_id = ? AND inbound_reply_id IS NULL`
      )
      .get(commentId) as
      | {
          due_at: string;
          count_start_at: string;
          limit_seconds: number;
          met_at: string | null;
          delay_staff_id: number | null;
          delay_recorded_at: string | null;
        }
      | undefined;
  const noticeBodies = (commentId: number) =>
    (
      appDb.prepare(`SELECT body FROM staff_notices WHERE comment_id = ? ORDER BY id ASC`).all(commentId) as Array<{
        body: string;
      }>
    ).map((row) => row.body);
  const setCursor = (staffId: number, username: string) => {
    appDb
      .prepare(
        `INSERT INTO auto_assign_state (id, last_staff_id, last_username, version)
         VALUES (1, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           last_staff_id = excluded.last_staff_id,
           last_username = excluded.last_username`
      )
      .run(staffId, username);
  };
  const setSuspension = (staffId: number, until: string | null, count = 0) => {
    appDb
      .prepare(
        `INSERT INTO staff_reply_sla (staff_id, delay_count, suspended_from, suspended_until, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(staff_id) DO UPDATE SET
           delay_count = excluded.delay_count,
           suspended_from = excluded.suspended_from,
           suspended_until = excluded.suspended_until,
           updated_at = excluded.updated_at`
      )
      .run(staffId, count, until ? PAST : null, until, PAST);
  };

  const early = addComment(idOf("eddie"), "2026-11-16 15:59:59");
  const boundary = addComment(idOf("eddie"), REPLY_SLA_START_UTC);
  let result = slaMod.scanReplySla(parseStoredTimestamp("2026-11-16 16:30:00", "utc") as Date);
  check("起計之前的客戶訊息唔開期限", opening(early) == null);
  const boundaryCase = opening(boundary);
  check(
    "正正 2026-11-17 00:00 香港時間開始計，夜晚窗推到 09:00，星期二用 2 小時",
    boundaryCase != null &&
      boundaryCase.count_start_at === T_IN &&
      boundaryCase.due_at === T_DUE &&
      Number(boundaryCase.limit_seconds) === 7200 &&
      boundaryCase.delay_recorded_at == null,
    JSON.stringify(boundaryCase)
  );
  check("未到期限唔當逾時", result.delays === 0 && pushes.length === 0);
  addOutbound(boundary, idOf("eddie"), T_ON_TIME);

  const onTime = addComment(idOf("eddie"), T_IN);
  addOutbound(onTime, idOf("eddie"), T_ON_TIME);
  const exact = addComment(idOf("jason"), T_IN);
  addOutbound(exact, idOf("jason"), T_DUE);
  const lateReply = addComment(idOf("jason"), T_IN);
  addOutbound(lateReply, idOf("jason"), "2026-11-17 04:00:00");
  const late = addComment(idOf("eddie"), T_IN);
  const oldThread = addComment(idOf("sam"), "2026-11-01 00:00:00");
  addOutbound(oldThread, idOf("sam"), "2026-11-10 02:00:00");
  const follow = addInbound(oldThread, T_IN);

  const lateNow = parseStoredTimestamp(T_LATE, "utc") as Date;
  const beforePushes = pushes.length;
  result = slaMod.scanReplySla(lateNow);
  check("準時回覆（包括剛好到期）唔計逾時", opening(onTime)?.met_at === T_ON_TIME && opening(exact)?.met_at === T_DUE);
  check("起計瞬間那則被準時回覆", opening(boundary)?.met_at === T_ON_TIME && stateOf(idOf("eddie")).delay_count === 1);
  const lateCase = opening(late);
  check(
    "期限後先回覆仍然逾時，計喺當時負責人",
    lateCase?.delay_staff_id === idOf("eddie") &&
      lateCase.delay_recorded_at === T_LATE &&
      opening(lateReply)?.delay_staff_id === idOf("jason"),
    JSON.stringify({ late: lateCase, lateReply: opening(lateReply) })
  );
  const lateNotices = noticeBodies(late);
  const latePushes = pushes.filter((item) => item.url === `/comments/${late}`);
  check(
    "逾時通知 Tony、Eddie、Benjamin 一次，內容有姓名、留言 id、客戶訊息同逾時",
    lateNotices.length === 3 &&
      lateNotices.every((body) => body === lateNotices[0]) &&
      lateNotices[0].includes("Eddie Lau") &&
      lateNotices[0].includes(`留言 #${late}`) &&
      lateNotices[0].includes("客戶首則") &&
      lateNotices[0].includes("逾時") &&
      !lateNotices[0].includes("暫停") &&
      latePushes.length === 1 &&
      latePushes[0].staffIds.join(",") === [idOf("tony"), idOf("eddie"), idOf("benjamin")].join(",") &&
      pushes.length === beforePushes + 3,
    lateNotices[0]
  );
  const pushesAfterLate = pushes.length;
  slaMod.scanReplySla(lateNow);
  check(
    "同一則入站再檢查唔會再通知或再加次數",
    pushes.length === pushesAfterLate && noticeBodies(late).length === 3 && stateOf(idOf("eddie")).delay_count === 1
  );

  const followCase = appDb
    .prepare(`SELECT delay_staff_id, met_at FROM reply_sla WHERE inbound_reply_id = ?`)
    .get(follow) as { delay_staff_id: number | null; met_at: string | null } | undefined;
  check(
    "舊對話喺起計之後的再留言先計，之前的同事回覆唔算覆到這則",
    followCase?.delay_staff_id === idOf("sam") && followCase.met_at == null
  );
  check("起計前的舊留言本身唔開期限", opening(oldThread) == null);
  check("客戶再留言唔當同事回覆", stateOf(idOf("sam")).delay_count === 1);

  const moved = addComment(idOf("jason"), T_IN);
  appDb.prepare(`UPDATE comments SET assignee_staff_id = ? WHERE id = ?`).run(idOf("sam"), moved);
  slaMod.scanReplySla(lateNow);
  check(
    "到期時的負責人才計逾時",
    opening(moved)?.delay_staff_id === idOf("sam") && stateOf(idOf("jason")).delay_count === 1
  );
  appDb.prepare(`UPDATE comments SET assignee_staff_id = ? WHERE id = ?`).run(idOf("eddie"), moved);
  slaMod.scanReplySla(lateNow);
  check(
    "改派之後唔會再計一次",
    stateOf(idOf("sam")).delay_count === 2 && stateOf(idOf("eddie")).delay_count === 1 && noticeBodies(moved).length === 3
  );

  const orphan = addComment(null, T_IN);
  slaMod.scanReplySla(lateNow);
  const orphanCase = opening(orphan);
  const orphanText = noticeBodies(orphan)[0] || "";
  check(
    "未有負責人不計入同事，仍然通知",
    orphanCase?.delay_staff_id == null &&
      orphanCase?.delay_recorded_at === T_LATE &&
      orphanText.includes("未有負責人") &&
      orphanText.includes(`留言 #${orphan}`) &&
      orphanText.includes("逾時") &&
      orphanText.includes("沒有計入") &&
      stateOf(idOf("sam")).delay_count === 2,
    orphanText
  );

  const wingComments = [addComment(idOf("wing"), T_IN), addComment(idOf("wing"), T_IN), addComment(idOf("wing"), T_IN)];
  const pushesBeforeStrikes = pushes.length;
  slaMod.scanReplySla(lateNow);
  const until = formatUtcTimestamp(new Date(lateNow.getTime() + REPLY_SLA_SUSPEND_MS));
  const wing = stateOf(idOf("wing"));
  check(
    "第三次逾時暫停七日、次數歸零、帳號仍然可以登入",
    wing.delay_count === 0 && wing.suspended_until === until && wing.active === 1,
    JSON.stringify(wing)
  );
  check("頭兩次通知唔講暫停", !noticeBodies(wingComments[0])[0].includes("暫停") && !noticeBodies(wingComments[1])[0].includes("暫停"));
  const third = noticeBodies(wingComments[2])[0] || "";
  check(
    "第三次通知講暫停自動派單一星期",
    third.includes("Wing Cheng") &&
      third.includes(`留言 #${wingComments[2]}`) &&
      third.includes("逾時") &&
      third.includes("暫停自動派單一星期") &&
      third.includes("3 次"),
    third
  );
  slaMod.scanReplySla(lateNow);
  check("三次暫停的通知唔會重覆", pushes.length === pushesBeforeStrikes + 3 && noticeBodies(wingComments[2]).length === 3);

  setCursor(idOf("eddie"), "eddie");
  const skipped = [
    assignMod.pickNextAutoAssignStaffId(),
    assignMod.pickNextAutoAssignStaffId(),
    assignMod.pickNextAutoAssignStaffId(),
  ];
  check(
    "暫停中的同事像被排除的管理員一樣跳過",
    skipped.join(",") === [idOf("jason"), idOf("sam"), idOf("eddie")].join(","),
    skipped.join(",")
  );

  const during = addComment(idOf("wing"), T_IN);
  const duringNow = parseStoredTimestamp("2026-11-17 07:00:00", "utc") as Date;
  slaMod.scanReplySla(duringNow);
  const duringState = stateOf(idOf("wing"));
  const duringText = noticeBodies(during)[0] || "";
  check(
    "暫停期間的新逾時仍然通知，並計入下一輪，唔會提早解封",
    duringState.delay_count === 1 &&
      duringState.suspended_until === until &&
      duringText.includes("逾時") &&
      !duringText.includes("暫停") &&
      duringState.active === 1,
    JSON.stringify(duringState)
  );
  const cycle = [addComment(idOf("wing"), T_IN), addComment(idOf("wing"), T_IN)];
  slaMod.scanReplySla(duringNow);
  const renewedUntil = formatUtcTimestamp(new Date(duringNow.getTime() + REPLY_SLA_SUSPEND_MS));
  const renewed = stateOf(idOf("wing"));
  check(
    "暫停期間再累積到三次會重新暫停七日，次數再歸零",
    renewed.delay_count === 0 &&
      renewed.suspended_until === renewedUntil &&
      renewed.active === 1 &&
      !noticeBodies(cycle[0])[0].includes("暫停") &&
      noticeBodies(cycle[1])[0].includes("暫停自動派單一星期"),
    JSON.stringify(renewed)
  );

  const pool = [idOf("eddie"), idOf("wing"), idOf("jason"), idOf("sam")];
  for (const staffId of pool) setSuspension(staffId, FUTURE, 0);
  setCursor(idOf("eddie"), "eddie");
  const versionBefore = (
    appDb.prepare(`SELECT version, last_staff_id FROM auto_assign_state WHERE id = 1`).get() as {
      version: number;
      last_staff_id: number;
    }
  );
  check("全部暫停時沒有人可派", assignMod.pickNextAutoAssignStaffId() == null && assignMod.hasEligibleAutoAssignStaff() === false);
  const versionAfter = appDb.prepare(`SELECT version, last_staff_id FROM auto_assign_state WHERE id = 1`).get() as {
    version: number;
    last_staff_id: number;
  };
  check(
    "沒有人可派時不推進游標",
    versionAfter.version === versionBefore.version && versionAfter.last_staff_id === versionBefore.last_staff_id
  );

  appDb.prepare(`UPDATE staff_reply_sla SET suspended_until = ? WHERE staff_id = ?`).run(PAST, idOf("wing"));
  const stillStored = stateOf(idOf("wing")).suspended_until;
  check("到期後欄位可以仍未清理，派單不靠人手清旗標", stillStored === PAST);
  check(
    "到期那刻（suspended_until 不大於而家）已經可以再派",
    assignMod.hasEligibleAutoAssignStaff(parseStoredTimestamp(PAST, "utc") as Date) === true
  );
  const edge = "2026-11-24 06:00:00";
  for (const staffId of pool) setSuspension(staffId, edge, 1);
  check(
    "正正到期已回到輪候，早一秒仍然暫停",
    assignMod.hasEligibleAutoAssignStaff(parseStoredTimestamp(edge, "utc") as Date) === true &&
      assignMod.hasEligibleAutoAssignStaff(parseStoredTimestamp("2026-11-24 05:59:59", "utc") as Date) === false
  );
  for (const staffId of pool) setSuspension(staffId, FUTURE, 1);
  appDb.prepare(`UPDATE staff_reply_sla SET suspended_until = ?, delay_count = 1 WHERE staff_id = ?`).run(PAST, idOf("wing"));
  const restoredPick = assignMod.pickNextAutoAssignStaffId();
  check(
    "七日到期自動回到輪流，清理函數未跑都派得中",
    restoredPick === idOf("wing") && stateOf(idOf("wing")).suspended_until === PAST && stateOf(idOf("wing")).active === 1,
    `pick=${restoredPick}`
  );

  const restored = slaMod.scanReplySla(parseStoredTimestamp("2026-11-17 08:00:00", "utc") as Date);
  check(
    "檢查器清走到期暫停，但保留下一輪次數",
    restored.restored >= 1 && stateOf(idOf("wing")).suspended_until == null && stateOf(idOf("wing")).delay_count === 1,
    JSON.stringify(stateOf(idOf("wing")))
  );

  appDb.prepare(`UPDATE staff_reply_sla SET suspended_until = ?, delay_count = 1 WHERE staff_id = ?`).run(PAST, idOf("wing"));
  appDb.pragma("wal_checkpoint(PASSIVE)");
  const outFile = path.join(tmp, "pick.json");
  const child = spawnSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    [
      "-e",
      `const fs = require("fs");
       const { pickNextAutoAssignStaffId } = require("./src/services/assign.ts");
       const { db } = require("./src/db/index.ts");
       const id = pickNextAutoAssignStaffId();
       const row = id ? db.prepare("SELECT username FROM staff WHERE id = ?").get(id) : null;
       fs.writeFileSync(process.env.SLA_PICK_OUT, JSON.stringify({ id: id, username: row && row.username }));`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        INBOX_DB: "sqlite",
        DATABASE_PATH: dbFile,
        SLA_PICK_OUT: outFile,
      },
    }
  );
  const fresh = fs.existsSync(outFile) ? (JSON.parse(fs.readFileSync(outFile, "utf8")) as { id: number; username: string }) : null;
  check(
    "伺服器喺暫停中途重啟，到期後新進程不用管理員就再派給他",
    child.status === 0 && fresh?.username === "wing" && fresh.id === idOf("wing"),
    child.stderr?.slice(-400) || JSON.stringify(fresh)
  );

  for (const staffId of [idOf("eddie"), idOf("jason"), idOf("sam")]) setSuspension(staffId, null, 0);
  const tonyComments = [addComment(idOf("tony"), T_IN), addComment(idOf("tony"), T_IN), addComment(idOf("tony"), T_IN)];
  slaMod.scanReplySla(lateNow);
  const tonyState = stateOf(idOf("tony"));
  check(
    "已排除的管理員逾時會通知，但不會暫停派單",
    tonyState.delay_count === 3 &&
      tonyState.suspended_until == null &&
      !noticeBodies(tonyComments[2])[0].includes("暫停") &&
      noticeBodies(tonyComments[2])[0].includes("Tony Chan"),
    JSON.stringify(tonyState)
  );
  setCursor(idOf("sam"), "sam");
  check("Tony 仍然不在自動派單", assignMod.pickNextAutoAssignStaffId() === idOf("eddie"));

  appDb.prepare(`UPDATE staff SET username = ? WHERE id = ?`).run("lau.eddie", idOf("eddie"));
  const lookedUp = addComment(idOf("eddie"), T_IN);
  const pushesBeforeLookup = pushes.length;
  slaMod.scanReplySla(lateNow);
  const lookupPush = pushes.slice(pushesBeforeLookup).find((item) => item.url === `/comments/${lookedUp}`);
  check(
    "Eddie Lau 用員工表的顯示名對上，不靠估 id",
    lookupPush != null && lookupPush.staffIds.includes(idOf("eddie")) && lookupPush.body.includes("Eddie Lau"),
    lookupPush?.body
  );
  appDb.prepare(`UPDATE staff SET username = 'eddie' WHERE id = ?`).run(idOf("eddie"));

  const stale = addComment(idOf("eddie"), "2026-11-01 02:00:00");
  const denied = await repliesMod.createStaffReply({
    commentId: stale,
    staffId: idOf("wing"),
    body: "我已經不是負責人",
    viewer: { staffId: idOf("wing"), isAdmin: false },
  });
  const assigneeStill = appDb.prepare(`SELECT assignee_staff_id AS id FROM comments WHERE id = ?`).get(stale) as {
    id: number;
  };
  check(
    "舊負責人回覆仍然 403",
    !denied.ok && denied.ok === false && denied.status === 403 && denied.error.includes("請刷新頁面") && assigneeStill.id === idOf("eddie"),
    denied.ok ? "sent" : denied.error
  );

  setSuspension(idOf("wing"), FUTURE, 2);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(session({ secret: "sla-demo", resave: false, saveUninitialized: false }));
  app.use("/api", apiRoutes.apiRouter);
  app.use(pageRoutes.pagesRouter);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const login = async (username: string) => {
      const res = await fetch(`${base}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username, password: DEMO_PASSWORD }),
      });
      return cookieHeader(res);
    };
    const tonyCookie = await login("tony");
    const wingCookie = await login("wing");
    check("管理員同同事都可以登入", tonyCookie.includes("connect.sid=") && wingCookie.includes("connect.sid="));

    const tonyPage = await fetch(`${base}/staff`, { headers: { cookie: tonyCookie } });
    const tonyHtml = await tonyPage.text();
    check(
      "管理員看到逾時次數、暫停到期同自動恢復",
      tonyPage.status === 200 &&
        tonyHtml.includes("逾時次數") &&
        tonyHtml.includes("暫停至 2999-01-01 08:00:00 HKT（到期自動恢復輪候）") &&
        tonyHtml.includes("暫停七日後自動恢復輪候，唔使管理員人手恢復") &&
        tonyHtml.includes(">2</td>") &&
        tonyHtml.includes("不參與自動派單") &&
        !tonyHtml.includes("手動恢復"),
      String(tonyPage.status)
    );
    const wingPage = await fetch(`${base}/staff`, { headers: { cookie: wingCookie } });
    const wingHtml = await wingPage.text();
    check("同事名單的逾時狀態只給管理員看", wingPage.status === 200 && !wingHtml.includes("逾時次數") && !wingHtml.includes("暫停至"));

    appDb.prepare(`UPDATE staff_reply_sla SET suspended_until = ? WHERE staff_id = ?`).run(PAST, idOf("wing"));
    const afterPage = await fetch(`${base}/staff`, { headers: { cookie: tonyCookie } });
    const afterHtml = await afterPage.text();
    check(
      "頁面用到期時間判斷已恢復，不用管理員按鈕",
      afterHtml.includes("輪候中") && !afterHtml.includes("暫停至") && !afterHtml.includes("恢復派單")
    );

    const latestNotice = slaMod.latestSlaNoticeId(idOf("tony"));
    const newest = addComment(idOf("jason"), T_IN);
    slaMod.scanReplySla(lateNow);
    const updates = await fetch(
      `${base}/api/comments/updates?since_id=${newest}&since_notice_id=${latestNotice}`,
      { headers: { cookie: tonyCookie, accept: "application/json" } }
    );
    const updatesJson = (await updates.json()) as {
      sla_notices?: Array<{ body: string; url: string; title: string }>;
      latest_notice_id?: number;
    };
    const again = await fetch(
      `${base}/api/comments/updates?since_id=${newest}&since_notice_id=${updatesJson.latest_notice_id ?? latestNotice}`,
      { headers: { cookie: tonyCookie, accept: "application/json" } }
    );
    const againJson = (await again.json()) as { sla_notices?: unknown[] };
    const wingUpdates = await fetch(`${base}/api/comments/updates?since_id=${newest}&since_notice_id=0`, {
      headers: { cookie: wingCookie, accept: "application/json" },
    });
    const wingJson = (await wingUpdates.json()) as { sla_notices?: unknown[] };
    const bad = await fetch(`${base}/api/comments/updates?since_id=0&since_notice_id=nope`, {
      headers: { cookie: tonyCookie, accept: "application/json" },
    });
    check(
      "頁內通知只送一次給指定管理員",
      updates.status === 200 &&
        updatesJson.sla_notices?.length === 1 &&
        updatesJson.sla_notices[0].title === "回覆逾時" &&
        updatesJson.sla_notices[0].url === `/comments/${newest}` &&
        updatesJson.sla_notices[0].body.includes("Jason Cheng") &&
        againJson.sla_notices?.length === 0 &&
        wingJson.sla_notices?.length === 0 &&
        bad.status === 400,
      JSON.stringify(updatesJson.sla_notices)
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      appDb.close();
    } catch {
      // 檔案清理失敗唔影響斷言。
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  clockCases();
  await dbCases();
  if (failures.length) {
    console.error(`\n${failures.length} 項失敗`);
    return 1;
  }
  console.log("\n回覆時限通過");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
