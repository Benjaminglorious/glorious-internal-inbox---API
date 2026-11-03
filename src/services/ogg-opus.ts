/**
 * 將瀏覽器 MediaRecorder 嘅 WebM/Opus 改包裝成 Ogg/Opus。
 * WhatsApp Cloud API 接受 audio/ogg（Opus），唔接受 audio/webm。
 * 唔使 ffmpeg，亦唔會重新編碼，只係搬 Opus packet。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      if (r & 0x80000000) r = ((r << 1) ^ 0x04c11db7) >>> 0;
      else r = (r << 1) >>> 0;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(buf: Buffer): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

interface Vint {
  length: number;
  /** Size vint 先有意義。Id 請用 raw。 */
  value: number;
  unknown: boolean;
  raw: Buffer;
}

function readVint(buf: Buffer, offset: number, keepMarker: boolean): Vint | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let marker = 0x80;
  let length = 1;
  while (length <= 8 && (first & marker) === 0) {
    marker >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buf.length) return null;
  const raw = Buffer.from(buf.subarray(offset, offset + length));
  if (keepMarker) return { length, value: 0, unknown: false, raw };
  let allOnes = true;
  for (let i = 0; i < length; i++) {
    const mask = i === 0 ? marker - 1 : 0xff;
    if (mask !== 0 && (raw[i] & mask) !== mask) allOnes = false;
  }
  if (allOnes) return { length, value: 0, unknown: true, raw };
  let value = first & (marker - 1);
  for (let i = 1; i < length; i++) value = value * 256 + raw[i];
  if (!Number.isSafeInteger(value)) return null;
  return { length, value, unknown: false, raw };
}

interface Element {
  id: Buffer;
  dataStart: number;
  dataEnd: number;
  next: number;
}

function readElement(buf: Buffer, offset: number, limit: number): Element | null {
  const id = readVint(buf, offset, true);
  if (!id) return null;
  const size = readVint(buf, offset + id.length, false);
  if (!size) return null;
  const dataStart = offset + id.length + size.length;
  const dataEnd = size.unknown ? limit : dataStart + size.value;
  if (dataEnd > limit || dataEnd < dataStart) return null;
  return { id: id.raw, dataStart, dataEnd, next: dataEnd };
}

function idIs(id: Buffer, bytes: number[]): boolean {
  if (id.length !== bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (id[i] !== bytes[i]) return false;
  return true;
}

function walk(buf: Buffer, start: number, end: number, visit: (el: Element) => void): void {
  let offset = start;
  while (offset + 2 <= end) {
    const el = readElement(buf, offset, end);
    if (!el) break;
    visit(el);
    if (el.next <= offset) break;
    offset = el.next;
  }
}

function readUint(data: Buffer): number {
  let n = 0;
  const take = Math.min(data.length, 6);
  for (let i = 0; i < take; i++) n = n * 256 + data[i];
  return n;
}

function blockPayload(data: Buffer): { track: number; payload: Buffer } | null {
  const track = readVint(data, 0, false);
  if (!track || track.unknown) return null;
  const flagsAt = track.length + 2;
  if (data.length < flagsAt + 1) return null;
  const flags = data[flagsAt];
  const lacing = (flags >> 1) & 0x03;
  if (lacing !== 0) return null;
  return { track: track.value, payload: data.subarray(flagsAt + 1) };
}

function opusSamples(packet: Buffer): number {
  if (packet.length < 1) return 960;
  const config = packet[0] >> 3;
  const code = packet[0] & 0x03;
  const ms = [
    10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10,
    20, 2.5, 5, 10, 20,
  ][config] ?? 20;
  let frames = 1;
  if (code === 1 || code === 2) frames = 2;
  else if (code === 3 && packet.length > 1) frames = packet[1] & 0x3f;
  if (frames < 1) frames = 1;
  return Math.round(ms * 48 * frames);
}

function oggPage(packets: Buffer[], headerType: number, granule: bigint, serial: number, seq: number): Buffer {
  const segs: number[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    if (remaining === 0) segs.push(0);
    while (remaining >= 255) {
      segs.push(255);
      remaining -= 255;
    }
    segs.push(remaining);
  }
  if (segs.length > 255) throw new Error("Ogg 頁太長");
  const header = Buffer.alloc(27 + segs.length);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = headerType;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(seq >>> 0, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segs.length;
  for (let i = 0; i < segs.length; i++) header[27 + i] = segs[i];
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function defaultOpusHead(): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;
  return head;
}

function opusTags(): Buffer {
  const vendor = Buffer.from("glorious-inbox");
  const out = Buffer.alloc(8 + 4 + vendor.length + 4);
  out.write("OpusTags", 0, "ascii");
  out.writeUInt32LE(vendor.length, 8);
  vendor.copy(out, 12);
  out.writeUInt32LE(0, 12 + vendor.length);
  return out;
}

/**
 * WebM（EBML）入面嘅 A_OPUS → Ogg Opus。
 * 已經係 OggS 就原樣返回。
 */
export function remuxWebmOpusToOgg(input: Buffer): Buffer {
  if (input.length >= 4 && input.toString("ascii", 0, 4) === "OggS") return input;
  const found: { audioTrack: number; codecPrivate: Buffer | null; packets: Buffer[] } = {
    audioTrack: 0,
    codecPrivate: null,
    packets: [],
  };

  const takeTrack = (entry: Buffer): void => {
    let number = 0;
    let type = 0;
    let codec = "";
    let priv: Buffer | null = null;
    walk(entry, 0, entry.length, (el) => {
      const data = entry.subarray(el.dataStart, el.dataEnd);
      if (idIs(el.id, [0xd7])) number = readUint(data);
      else if (idIs(el.id, [0x83])) type = readUint(data);
      else if (idIs(el.id, [0x86])) codec = data.toString("ascii");
      else if (idIs(el.id, [0x63, 0xa2])) priv = Buffer.from(data);
    });
    if (type === 2 && codec === "A_OPUS" && number > 0) {
      found.audioTrack = number;
      found.codecPrivate = priv;
    }
  };

  const takeBlock = (data: Buffer): void => {
    const block = blockPayload(data);
    if (!block || block.track !== found.audioTrack || block.payload.length === 0) return;
    found.packets.push(Buffer.from(block.payload));
  };

  const scan = (buf: Buffer, start: number, end: number): void => {
    walk(buf, start, end, (el) => {
      if (idIs(el.id, [0x18, 0x53, 0x80, 0x67]) || idIs(el.id, [0x16, 0x54, 0xae, 0x6b]) || idIs(el.id, [0x1f, 0x43, 0xb6, 0x75])) {
        scan(buf, el.dataStart, el.dataEnd);
        return;
      }
      if (idIs(el.id, [0xae])) takeTrack(buf.subarray(el.dataStart, el.dataEnd));
      else if (idIs(el.id, [0xa0])) scan(buf, el.dataStart, el.dataEnd);
      else if (idIs(el.id, [0xa3]) || idIs(el.id, [0xa1])) takeBlock(buf.subarray(el.dataStart, el.dataEnd));
    });
  };

  scan(input, 0, input.length);
  const packets = found.packets;
  const codecPrivate = found.codecPrivate;
  if (!found.audioTrack || packets.length === 0) {
    throw new Error("WebM 入面搵唔到 Opus 語音");
  }

  const head =
    codecPrivate && codecPrivate.length >= 8 && codecPrivate.toString("ascii", 0, 8) === "OpusHead"
      ? codecPrivate
      : defaultOpusHead();
  const serial = 0x6c6f7267;
  const pages: Buffer[] = [oggPage([head], 0x02, 0n, serial, 0), oggPage([opusTags()], 0x00, 0n, serial, 1)];
  let granule = 0n;
  packets.forEach((packet, index) => {
    granule += BigInt(opusSamples(packet));
    const last = index === packets.length - 1;
    pages.push(oggPage([packet], last ? 0x04 : 0x00, granule, serial, index + 2));
  });
  return Buffer.concat(pages);
}

export function prepareChannelAudio(
  bytes: Buffer,
  mime: string
): { ok: true; bytes: Buffer; mime: string } | { ok: false; error: string } {
  if (mime === "audio/ogg" || mime === "audio/mpeg" || mime === "audio/mp4" || mime === "audio/aac" || mime === "audio/amr") {
    return { ok: true, bytes, mime };
  }
  if (mime === "audio/webm") {
    try {
      const ogg = remuxWebmOpusToOgg(bytes);
      if (ogg.length < 4 || ogg.toString("ascii", 0, 4) !== "OggS") {
        return { ok: false, error: "語音轉換失敗。請改用上傳 ogg、m4a 或 mp3。" };
      }
      return { ok: true, bytes: ogg, mime: "audio/ogg" };
    } catch {
      return {
        ok: false,
        error: "語音係 WebM，轉換做 WhatsApp／Messenger 用嘅 Ogg 失敗。請改用上傳 ogg、m4a 或 mp3，或者用 Safari 錄製。",
      };
    }
  }
  return { ok: false, error: "呢種語音格式未支援發送。請用 Ogg、M4A、MP3、AAC 或瀏覽器錄音。" };
}
