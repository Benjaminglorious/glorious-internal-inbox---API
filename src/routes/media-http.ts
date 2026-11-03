import { Request, Response } from "express";
import { sessionViewer } from "../auth/middleware";
import { readVisibleMedia } from "../services/media";

/** 已登入而且睇到該留言先至出 bytes。唔好放去 public。 */
export async function sendMedia(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(404).end();
    return;
  }
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const body = await readVisibleMedia(id, sessionViewer(req), range);
  if (body.status === 404) {
    res.status(404).end();
    return;
  }
  if (body.status === 416) {
    res.status(416);
    res.set("Content-Range", body.contentRange || `bytes */${body.total || 0}`);
    res.end();
    return;
  }
  res.status(body.status);
  res.set("Content-Type", body.mime || "application/octet-stream");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Disposition", `inline; filename="${body.filename || "media"}"`);
  res.set("Accept-Ranges", "bytes");
  res.set("Cache-Control", "private, max-age=300");
  if (body.contentRange) res.set("Content-Range", body.contentRange);
  res.set("Content-Length", String(body.bytes?.length ?? 0));
  res.end(body.bytes);
}
