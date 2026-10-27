/* 東榮內部留言 service worker。
 * 只負責安裝條件同 Web Push。唔快取 HTML／API，避免登入同留言輪詢食到舊資料。
 */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // 註冊 fetch 先符合瀏覽器嘅「可安裝」條件。唔呼叫 respondWith，請求照行網絡。
});

function safePath(value) {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("://")) {
    return "/";
  }
  if (value === "/" || value.startsWith("/comments/")) return value;
  return "/";
}

function isInboxUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== self.location.origin) return false;
    return parsed.pathname === "/" || parsed.pathname.startsWith("/comments/");
  } catch (err) {
    return false;
  }
}

function readPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    try {
      const text = event.data.text();
      return text ? { body: String(text) } : {};
    } catch (err2) {
      return {};
    }
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  const bodySource = typeof payload.body === "string" ? payload.body.trim() : "";
  const body = (bodySource || "留言箱有新訊息").slice(0, 180);
  const path = safePath(payload.url);
  const tag = typeof payload.tag === "string" && payload.tag.trim() ? payload.tag.trim().slice(0, 64) : "glorious-inbox-new";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      let inboxVisible = false;
      for (const client of windows) {
        if (!isInboxUrl(client.url)) continue;
        client.postMessage({ type: "inbox-push", url: path });
        if (client.visibilityState === "visible") inboxVisible = true;
      }
      if (inboxVisible) return;
      await self.registration.showNotification("有新留言", {
        body: body,
        lang: "zh-Hant",
        tag: tag,
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        data: { url: path },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch (err) {
          sameOrigin = false;
        }
        if (!sameOrigin || typeof client.focus !== "function") continue;
        await client.focus();
        if (typeof client.navigate === "function") {
          try {
            await client.navigate(target);
            return;
          } catch (err) {
            // 舊視窗導頁失敗就改用訊息，再唔得就開新視窗。
          }
        }
        client.postMessage({ type: "inbox-open", url: path });
        return;
      }
      await self.clients.openWindow(target);
    })()
  );
});
