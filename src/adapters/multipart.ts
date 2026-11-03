import { randomBytes } from "crypto";

export function encodeFormData(
  parts: Array<{ name: string; value: Buffer | string; filename?: string; contentType?: string }>
): { body: Buffer; contentType: string } {
  const boundary = `----Glorious${randomBytes(12).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const filename = part.filename?.replace(/[\r\n"]/g, "") || "";
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (filename) header += `; filename="${filename}"`;
    header += "\r\n";
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += "\r\n";
    chunks.push(Buffer.from(header));
    chunks.push(typeof part.value === "string" ? Buffer.from(part.value) : part.value);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
