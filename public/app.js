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
    whatsapp: "WhatsApp",
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
      var author = comment.author_name ? String(comment.author_name) : "（無名）";
      var preview = comment.preview ? String(comment.preview) : "（沒有內容）";
      return source + " · " + author + "：" + preview;
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
    text.textContent = "有新留言時，可以彈出桌面通知（只會喺呢個分頁喺背景時顯示）。";

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

    allow.addEventListener("click", function () {
      remember();
      bar.remove();
      try {
        Notification.requestPermission().catch(function () {});
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
