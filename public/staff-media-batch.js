/* 同事一次過揀多個媒體檔再發送。後端仍然每次收一個檔，呢度只決定次序、說明同失敗點停。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GloriousStaffMedia = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var MAX_STAFF_MEDIA_BATCH = 30;

  function fileLooksLikeImage(file) {
    var type = String((file && file.type) || "").toLowerCase();
    if (type.indexOf("image/") === 0) return true;
    var name = String((file && file.name) || "").toLowerCase();
    return /\.(jpe?g|png|webp|gif)$/.test(name);
  }

  function fileLooksLikeVideo(file) {
    var type = String((file && file.type) || "").toLowerCase();
    if (type.indexOf("video/") === 0) return true;
    var name = String((file && file.name) || "").toLowerCase();
    return /\.(mp4|3gpp?)$/.test(name);
  }

  function planStaffMediaSelection(files) {
    var list = [];
    var source = files || [];
    for (var i = 0; i < source.length; i++) list.push(source[i]);
    if (!list.length) return { ok: false, error: "", files: [] };
    if (list.length > MAX_STAFF_MEDIA_BATCH) {
      return {
        ok: false,
        error: "一次最多揀 " + MAX_STAFF_MEDIA_BATCH + " 個檔案。請減少數量再發送。",
        files: [],
      };
    }
    return { ok: true, error: "", files: list };
  }

  function allImages(items) {
    if (!items || !items.length) return false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item && item.voice) return false;
      if (!fileLooksLikeImage((item && item.file) || item)) return false;
    }
    return true;
  }

  function selectionStatus(files) {
    if (!files || !files.length) return "";
    if (files.length === 1) {
      return "已揀好「" + (files[0].name || "檔案") + "」。撳發送媒體。";
    }
    var noun = allImages(files) ? "張相片" : "個檔案";
    return "已揀好 " + files.length + " " + noun + "。會按揀選次序發送。撳發送媒體。";
  }

  function sendButtonLabel(items) {
    if (!items || items.length <= 1) return "發送媒體";
    if (allImages(items)) return "發送 " + items.length + " 張相片";
    return "發送 " + items.length + " 個媒體";
  }

  function sendingStatus(index, total) {
    if (total <= 1) return "發送中…";
    return "發送中…（" + (index + 1) + "/" + total + "）";
  }

  function captionTargetIndex(items) {
    if (!items || items.length <= 1) return 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item && item.voice) continue;
      var file = (item && item.file) || item;
      if (fileLooksLikeImage(file) || fileLooksLikeVideo(file)) return i;
    }
    return 0;
  }

  function captionForStaffMedia(items, index, caption) {
    var text = caption || "";
    if (!items || items.length <= 1) return text;
    return index === captionTargetIndex(items) ? text : "";
  }

  function uniformDelivery(statuses) {
    if (!statuses || !statuses.length) return "stored";
    for (var i = 1; i < statuses.length; i++) {
      if (statuses[i] !== statuses[0]) return "stored";
    }
    return statuses[0] || "stored";
  }

  /**
   * 一個檔嘅 HTTP 結果。403 或中途失敗就停，已經送出嘅唔會重送。
   * state: { total, index, sent, statuses }
   * result: { ok, status, error, delivery, network }
   */
  function reduceStaffMediaSend(state, result) {
    var total = state.total;
    var index = state.index;
    var sent = state.sent;
    var statuses = state.statuses ? state.statuses.slice() : [];
    if (result.network) {
      if (sent === 0) {
        return {
          action: "stay",
          statusText: "未能發送媒體。請再試一次。",
          enableSend: true,
          keepFrom: 0,
          sent: 0,
          statuses: statuses,
          delivery: "",
          error: "",
        };
      }
      return {
        action: "stay",
        statusText: "已發送 " + sent + " 個。其餘未能發送。請再試一次。",
        enableSend: true,
        keepFrom: index,
        sent: sent,
        statuses: statuses,
        delivery: "",
        error: "",
      };
    }
    if (!result.ok) {
      var message = result.error || "未能發送媒體";
      if (sent === 0) {
        if (result.status === 403) {
          return {
            action: "stay",
            statusText: message,
            enableSend: true,
            keepFrom: 0,
            sent: 0,
            statuses: statuses,
            delivery: "",
            error: message,
          };
        }
        return {
          action: "redirect-error",
          statusText: message,
          enableSend: false,
          keepFrom: 0,
          sent: 0,
          statuses: statuses,
          delivery: "",
          error: message,
        };
      }
      return {
        action: "stay",
        statusText: "已發送 " + sent + " 個。其餘未發送：" + message,
        enableSend: true,
        keepFrom: index,
        sent: sent,
        statuses: statuses,
        delivery: "",
        error: message,
      };
    }
    statuses.push(result.delivery || "stored");
    var nextSent = sent + 1;
    if (index + 1 < total) {
      return {
        action: "continue",
        statusText: "",
        enableSend: false,
        keepFrom: index + 1,
        sent: nextSent,
        statuses: statuses,
        delivery: "",
        error: "",
      };
    }
    return {
      action: "redirect-ok",
      statusText: "",
      enableSend: false,
      keepFrom: total,
      sent: nextSent,
      statuses: statuses,
      delivery: uniformDelivery(statuses),
      error: "",
    };
  }

  function sentUrl(commentId, delivery) {
    return (
      "/comments/" +
      encodeURIComponent(commentId) +
      "?sent=1&delivery=" +
      encodeURIComponent(delivery || "stored") +
      "#thread"
    );
  }

  function errorUrl(commentId, message) {
    return "/comments/" + encodeURIComponent(commentId) + "?error=" + encodeURIComponent(message) + "#staff-media";
  }

  return {
    MAX_STAFF_MEDIA_BATCH: MAX_STAFF_MEDIA_BATCH,
    fileLooksLikeImage: fileLooksLikeImage,
    fileLooksLikeVideo: fileLooksLikeVideo,
    planStaffMediaSelection: planStaffMediaSelection,
    selectionStatus: selectionStatus,
    sendButtonLabel: sendButtonLabel,
    sendingStatus: sendingStatus,
    captionForStaffMedia: captionForStaffMedia,
    uniformDelivery: uniformDelivery,
    reduceStaffMediaSend: reduceStaffMediaSend,
    sentUrl: sentUrl,
    errorUrl: errorUrl,
  };
});
