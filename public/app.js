// 留言箱同留言詳情：輪詢新留言，顯示頁內提示、分頁標題數字，以及可選桌面通知。
// 表單仍然係整頁提交。WhatsApp 連結由伺服器從 COMPANY_WHATSAPP_URL 渲染。
// 其他客戶端應讀 GET /api/config（GET /api/health 都有），唔好自己硬編碼。
(function () {
  var POLL_MS = 20000;
  var INITIAL_MS = 1500;
  var STORAGE_KEY = "glorious.inbox.notifyAsked";
  var SOURCE_LABEL = {
    "28car": "28car",
    glorious_web: "東榮官網",
    facebook: "Facebook",
    instagram: "東榮 IG",
    whatsapp: "WhatsApp",
  };
  var ORIGIN_LABEL = {
    "28car": "28car",
    glorious_web: "東榮官網",
    facebook: "Facebook",
    instagram: "東榮 IG",
  };

  document.addEventListener("DOMContentLoaded", function () {
    var root = document.getElementById("inbox-live");
    if (!root) return;
    var raw = root.getAttribute("data-latest-id");
    if (raw == null || !/^\d+$/.test(raw)) return;
    startWatcher(Number(raw));
  });

  function startWatcher(initialCursor) {
    var cursor = initialCursor;
    var unseenCount = 0;
    var newest = null;
    var baseTitle = document.title;
    var stopped = false;
    var polling = false;
    var pollAgain = false;
    var timer = 0;
    var toast = buildToast();
    maybeAskPermission();

    function schedule(ms) {
      if (stopped) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(poll, ms);
    }

    function summary(comment) {
      var source = SOURCE_LABEL[comment.source] || comment.source || "留言";
      var label = source;
      if (comment.entry_path === "28car_board") label = "28car 留言板";
      else if (comment.entry_path === "28car_wa_link") label = "28car 留言區 WhatsApp";
      else if (comment.intake_kind === "whatsapp_click") {
        var origin = comment.origin_site ? ORIGIN_LABEL[comment.origin_site] : "";
        label = origin ? "來自" + origin + "的 WhatsApp" : "WhatsApp 聯絡";
      } else if (comment.intake_kind === "site_comment") {
        label = comment.source === "instagram" ? "東榮 IG 留言" : source + " 網站留言";
      }
      var author = comment.author_name ? String(comment.author_name) : "（無名）";
      var preview = comment.preview ? String(comment.preview) : "（沒有內容）";
      return label + " · " + author + "：" + preview;
    }

    function renderTitle() {
      document.title = unseenCount > 0 ? "(" + unseenCount + ") 內部留言箱" : baseTitle;
    }

    function showToast() {
      if (!newest) return;
      toast.summary.textContent = summary(newest);
      if (unseenCount > 1) {
        toast.more.hidden = false;
        toast.more.textContent = "共 " + unseenCount + " 則新留言";
        toast.view.textContent = "查看最新";
      } else {
        toast.more.hidden = true;
        toast.more.textContent = "";
        toast.view.textContent = "查看";
      }
      toast.view.href = "/comments/" + encodeURIComponent(newest.id);
      toast.root.hidden = false;
      document.body.classList.add("inbox-has-toast");
    }

    function hideToast() {
      toast.root.hidden = true;
      document.body.classList.remove("inbox-has-toast");
    }

    function maybeNotify(batch) {
      if (!batch.length || !document.hidden) return;
      if (document.documentElement.getAttribute("data-push-active") === "1") return;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      var latest = batch[batch.length - 1];
      var body =
        unseenCount > 1 ? "共 " + unseenCount + " 則新留言。最新：" + summary(latest) : summary(latest);
      try {
        var note = new Notification("有新留言", {
          body: body,
          tag: "glorious-inbox-new",
          lang: "zh-Hant",
        });
        note.onclick = function () {
          window.focus();
          window.location.assign("/comments/" + encodeURIComponent(latest.id));
        };
      } catch (err) {
        // 瀏覽器拒絕顯示通知時，頁內提示仍然有效。
      }
    }

    function absorb(comments) {
      var fresh = [];
      for (var i = 0; i < comments.length; i++) {
        var comment = comments[i];
        var id = Number(comment && comment.id);
        if (!isFinite(id) || id <= cursor) continue;
        fresh.push(comment);
      }
      if (!fresh.length) return;
      unseenCount += fresh.length;
      newest = fresh[fresh.length - 1];
      renderTitle();
      showToast();
      maybeNotify(fresh);
    }

    function poll() {
      if (stopped) return;
      if (polling) {
        pollAgain = true;
        return;
      }
      polling = true;
      window.clearTimeout(timer);
      var nextMs = POLL_MS;
      fetch("/api/comments/updates?since_id=" + encodeURIComponent(cursor), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      })
        .then(function (res) {
          if (res.status === 401) {
            stopped = true;
            return null;
          }
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (!data) return;
          var comments = Array.isArray(data.comments) ? data.comments : [];
          if (comments.length) absorb(comments);
          if (data.has_more && comments.length) {
            var lastId = Number(comments[comments.length - 1].id);
            if (isFinite(lastId) && lastId > cursor) cursor = lastId;
            nextMs = 400;
          } else if (typeof data.latest_id === "number" && data.latest_id > cursor) {
            cursor = data.latest_id;
          }
        })
        .catch(function () {
          // 網絡短暫失敗就等下一次輪詢。
        })
        .then(function () {
          polling = false;
          if (stopped) return;
          if (pollAgain) {
            pollAgain = false;
            schedule(0);
            return;
          }
          schedule(nextMs);
        });
    }

    toast.refresh.addEventListener("click", function () {
      window.location.reload();
    });
    toast.dismiss.addEventListener("click", function () {
      hideToast();
    });

    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener("message", function (event) {
        var data = event.data || {};
        if (data.type === "inbox-push") poll();
      });
    }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") poll();
    });
    window.addEventListener("pageshow", function (ev) {
      if (ev.persisted) poll();
    });

    schedule(INITIAL_MS);
  }

  function buildToast() {
    var root = document.createElement("div");
    root.className = "inbox-toast";
    root.hidden = true;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");

    var title = document.createElement("h2");
    title.textContent = "有新留言";

    var summary = document.createElement("p");
    summary.className = "inbox-toast-summary";

    var more = document.createElement("p");
    more.className = "inbox-toast-more";
    more.hidden = true;

    var actions = document.createElement("div");
    actions.className = "inbox-toast-actions";

    var view = document.createElement("a");
    view.className = "btn primary";
    view.textContent = "查看";

    var refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "btn";
    refresh.textContent = "重新整理";

    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn";
    dismiss.textContent = "關閉";

    actions.appendChild(view);
    actions.appendChild(refresh);
    actions.appendChild(dismiss);
    root.appendChild(title);
    root.appendChild(summary);
    root.appendChild(more);
    root.appendChild(actions);
    document.body.appendChild(root);

    return { root: root, summary: summary, more: more, view: view, refresh: refresh, dismiss: dismiss };
  }

  function maybeAskPermission() {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return null;
    var asked = false;
    try {
      asked = localStorage.getItem(STORAGE_KEY) === "1";
    } catch (err) {
      return null;
    }
    if (asked) return null;

    var bar = document.createElement("div");
    bar.className = "inbox-notify-ask";

    var text = document.createElement("p");
    text.textContent = "有新留言時可以彈出通知。開住嘅分頁會繼續用頁面提示；允許之後，背景分頁或者已安裝嘅程式都可以收到「有新留言」。";

    var actions = document.createElement("div");
    actions.className = "inbox-notify-actions";

    var allow = document.createElement("button");
    allow.type = "button";
    allow.className = "btn primary";
    allow.textContent = "開啟通知";

    var later = document.createElement("button");
    later.type = "button";
    later.className = "btn";
    later.textContent = "唔使";

    function remember() {
      try {
        localStorage.setItem(STORAGE_KEY, "1");
      } catch (err) {
        // 私隱模式寫唔到就當呢次頁面問過。
      }
    }

    function afterPermission(perm) {
      if (perm === "granted" && typeof window.gloriousSyncPush === "function") window.gloriousSyncPush();
    }

    allow.addEventListener("click", function () {
      remember();
      bar.remove();
      try {
        var ask = Notification.requestPermission(function (perm) {
          afterPermission(perm);
        });
        if (ask && typeof ask.then === "function") {
          ask.then(afterPermission).catch(function () {});
        }
      } catch (err) {
        // 舊瀏覽器可能用 callback 形式；失敗都唔影響頁內提示。
      }
    });
    later.addEventListener("click", function () {
      remember();
      bar.remove();
    });

    actions.appendChild(allow);
    actions.appendChild(later);
    bar.appendChild(text);
    bar.appendChild(actions);

    var main = document.querySelector("main.container");
    if (main) main.insertBefore(bar, main.firstChild);
    else document.body.appendChild(bar);
    return bar;
  }
})();

// 安裝 PWA、登記 service worker，以及（已允許通知而且伺服器有 VAPID 時）訂閱 Web Push。
// 頁內 toast／分頁標題仍然由上面嘅輪詢負責。
(function () {
  var INSTALL_KEY = "glorious.inbox.installDismissed";
  var deferredPrompt = null;

  window.gloriousSyncPush = function () {
    syncPush().catch(function () {});
  };

  var offerInstallButton = document.body && document.body.getAttribute("data-authenticated") === "1";

  window.addEventListener("beforeinstallprompt", function (event) {
    if (!offerInstallButton || dismissed()) return;
    event.preventDefault();
    deferredPrompt = event;
    var button = document.getElementById("pwa-install-btn");
    if (button) button.hidden = false;
  });

  window.addEventListener("appinstalled", function () {
    var bar = document.getElementById("pwa-install");
    if (bar) bar.remove();
    deferredPrompt = null;
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (event) {
      var data = event.data || {};
      if (data.type === "inbox-open" && isSafePath(data.url)) window.location.assign(data.url);
    });
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!document.body || document.body.getAttribute("data-authenticated") !== "1") return;
    showInstallHint();
    if (notificationState() === "granted") syncPush().catch(function () {});
    else if (notificationState() === "denied") dropPush().catch(function () {});
  });

  function notificationState() {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  }

  function isSafePath(url) {
    return typeof url === "string" && url.charAt(0) === "/" && url.charAt(1) !== "/" && url.indexOf("\\") === -1;
  }

  function isStandalone() {
    var media = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    return !!(media || navigator.standalone);
  }

  function isIos() {
    var ua = navigator.userAgent || "";
    if (/iphone|ipad|ipod/i.test(ua)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  }

  function dismissed() {
    try {
      return localStorage.getItem(INSTALL_KEY) === "1";
    } catch (err) {
      return false;
    }
  }

  function rememberDismiss() {
    try {
      localStorage.setItem(INSTALL_KEY, "1");
    } catch (err) {
      // 私隱模式寫唔到就當呢次頁面問過。
    }
  }

  function showInstallHint() {
    if (isStandalone() || dismissed()) return;

    var bar = document.createElement("div");
    bar.id = "pwa-install";
    bar.className = "inbox-install-ask";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "安裝應用程式");

    var text = document.createElement("p");
    text.textContent = isIos()
      ? "用 Safari 撳「分享」→「加入主畫面」，再開啟通知，就可以喺程式未開喺前面時收到「有新留言」。iPhone 嘅 Safari 分頁本身收唔到背景推送。"
      : "可以安裝「東榮內部留言」到主畫面。安裝並開啟通知之後，即使個頁面未開喺前面，都可以收到「有新留言」。";

    var note = document.createElement("p");
    note.className = "inbox-install-note";
    note.hidden = true;

    var actions = document.createElement("div");
    actions.className = "inbox-notify-actions";

    var install = document.createElement("button");
    install.type = "button";
    install.id = "pwa-install-btn";
    install.className = "btn primary";
    install.textContent = "安裝";
    install.hidden = !deferredPrompt;

    var later = document.createElement("button");
    later.type = "button";
    later.className = "btn";
    later.textContent = "稍後";

    install.addEventListener("click", function () {
      if (!deferredPrompt) return;
      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      install.hidden = true;
      var choice = promptEvent.userChoice;
      try {
        promptEvent.prompt();
      } catch (err) {
        return;
      }
      if (choice && typeof choice.then === "function") {
        choice
          .then(function (result) {
            if (result && result.outcome === "accepted") bar.remove();
          })
          .catch(function () {});
      }
    });

    later.addEventListener("click", function () {
      rememberDismiss();
      bar.remove();
    });

    actions.appendChild(install);
    actions.appendChild(later);
    bar.appendChild(text);
    bar.appendChild(note);
    bar.appendChild(actions);

    var main = document.querySelector("main.container");
    if (main) main.insertBefore(bar, main.firstChild);
    else document.body.appendChild(bar);

    fetch("/api/push/config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data || data.enabled) return;
        note.hidden = false;
        note.textContent = "伺服器未設定推送金鑰，關閉程式之後暫時收唔到。開住呢頁仍然會有頁內提示。";
      })
      .catch(function () {});
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  function syncPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return Promise.resolve();
    if (notificationState() !== "granted") return Promise.resolve();
    return fetch("/api/push/config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (cfg) {
        if (!cfg || !cfg.enabled || !cfg.public_key) return null;
        return navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.getSubscription().then(function (existing) {
            if (existing) return existing;
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(cfg.public_key),
            });
          });
        });
      })
      .then(function (sub) {
        if (!sub) return null;
        return fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(sub),
        }).then(function (res) {
          if (res.ok) document.documentElement.setAttribute("data-push-active", "1");
        });
      });
  }

  function dropPush() {
    if (!("serviceWorker" in navigator)) return Promise.resolve();
    return navigator.serviceWorker.ready.then(function (reg) {
      if (!reg.pushManager) return null;
      return reg.pushManager.getSubscription().then(function (sub) {
        if (!sub) return null;
        return fetch("/api/push/unsubscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).then(function () {
          return sub.unsubscribe();
        });
      });
    });
  }
})();

