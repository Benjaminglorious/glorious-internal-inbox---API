/**
 * 每次進入 28car 換一個出口。
 * 清單模式輪流用下一個代理；{session} 模式每次換 session，等供應商派新 IP。
 * 唔會回落到機房直連。租約 id 係雜湊，資料庫唔保存代理網址。
 */
import { createHash } from "crypto";
import { readEgress, type EgressConfig } from "./twentyeightcar-config";

export interface EgressLease {
  leaseId: string;
  proxyUrl: string;
  label: string;
  operation: string;
}

export interface EgressPick {
  lease: EgressLease;
  config: EgressConfig;
}

let sessionSeq = 0;

export function resetEgressSequenceForTests(): void {
  sessionSeq = 0;
}

function leaseIdFor(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function proxyLabel(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl.replaceAll("{session}", "session"));
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.hostname}:${port}`;
  } catch {
    return "proxy";
  }
}

/**
 * 揀一個同上一行動唔同嘅代理。lastLeaseId 係上次寫低嘅雜湊。
 * session 模板每次都產生新 URL，所以雜湊自然唔同。
 */
export function allocateLease(operation: string, lastLeaseId: string | null): EgressPick | { error: string } {
  const config = readEgress();
  if (!config.canRotate) {
    return { error: config.error || "未設定可輪換代理，已拒絕直連 28car" };
  }

  if (config.mode === "session_template" && config.template) {
    sessionSeq += 1;
    const session = `g${Date.now().toString(36)}${sessionSeq.toString(36)}`;
    let proxyUrl = config.template.replaceAll("{session}", session);
    let leaseId = leaseIdFor(proxyUrl);
    if (leaseId === lastLeaseId) {
      sessionSeq += 1;
      proxyUrl = config.template.replaceAll("{session}", `${session}x${sessionSeq.toString(36)}`);
      leaseId = leaseIdFor(proxyUrl);
    }
    return {
      config,
      lease: { leaseId, proxyUrl, label: proxyLabel(proxyUrl), operation },
    };
  }

  const items = config.proxies.map((proxyUrl) => ({
    proxyUrl,
    leaseId: leaseIdFor(proxyUrl),
    label: proxyLabel(proxyUrl),
  }));
  const unique = new Set(items.map((item) => item.leaseId));
  if (unique.size < 2) return { error: "代理位址重複，無法保證每次換 IP" };
  const start = lastLeaseId ? items.findIndex((item) => item.leaseId === lastLeaseId) : -1;
  for (let step = 1; step <= items.length; step += 1) {
    const item = items[(start + step) % items.length];
    if (item.leaseId !== lastLeaseId) {
      return {
        config,
        lease: { ...item, operation },
      };
    }
  }
  return { error: "代理輪換失敗" };
}
