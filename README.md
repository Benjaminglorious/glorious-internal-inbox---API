# 東榮汽車 · 內部留言系統（glorious-internal-inbox）

公司**內部專用**網頁，畀同事登入後處理客戶留言／查詢：

| 來源 | 網址 | 程式碼識別 | 畫面 |
|------|------|------------|------|
| 28car | https://www.28car.com | `28car` | 28car |
| 東榮官網 | https://glorious.hk/cn2/ | `glorious_web` | 東榮官網 |
| Facebook | https://www.facebook.com/GloriousMotors | `facebook` | Facebook |
| 東榮 Instagram | 簡介連結會去 `glorious.hk/?utm_source=ig` | `instagram` | 東榮 IG |
| WhatsApp | 公司總機 `85221740001` 同已綁定嘅同事個人號 | `whatsapp` | WhatsApp |

而家用**示範資料**；真實抓取適配器喺 `src/adapters/`（stub，標咗 TODO）。

> ⚠️ 呢個系統只供東榮內部同事使用，唔應公開喺互聯網冇保護咁部署。

## 需求

- Node.js 20+
- npm

## 快速開始

```bash
cp .env.example .env   # 改 SESSION_SECRET，以及 WEBHOOK_VERIFY_TOKEN（要用 webhook 先至需要）
npm install
npm run seed           # 寫入 11 位同事 + 示範留言（含 IG、WhatsApp 來源同回覆）+ 公司 WhatsApp 總機
npm start              # http://localhost:3001
```

開發模式（自動重載）：

```bash
npm run dev
```

## Render

免費 Web Service：

- **Build command：** `npm install`
- **Start command：** `npm run seed && npm start`

`npm start` 同 `npm run seed` 用 `tsx` 跑 TypeScript。`tsx` 喺 `dependencies`，所以 `NODE_ENV=production` 時 `npm install` 唔會漏咗佢（唔使 `--include=dev`）。`app.listen(PORT)` 冇指定 host，會聽所有網絡介面，Render 代理夠用。

`NODE_ENV=production` 時 session cookie 會加 `Secure`。程式已設 `trust proxy`，HTTPS 喺 Render 邊緣終止之後仍然有效。請設定夠長嘅 `SESSION_SECRET`。

免費方案大約 15 分鐘冇流量會休眠，下次請求要等喚醒。SQLite（`data/inbox.db`）喺臨時檔案系統；免費方案冇 persistent disk，deploy、重啟或休眠之後資料會消失，要再跑 seed。要留住檔案就要用付費方案掛 disk（掛載路徑要包住 `data/`）。

## 預設登入（示範）

**全部同事共用示範密碼（正式環境必須更改）：**

```
Glorious2026!
```

例子：

| 姓名 | 帳號 | 角色 |
|------|------|------|
| 陳東榮 | `tony` | 管理員 |
| 李詠詩 | `wing` | 同事 |
| 張嘉欣 | `kaixin` | 同事 |

其餘帳號見 seed：`ming` `mei` `ho` `yan` `chun` `sze` `kit` `yuki`。

## 功能

- 登入／登出（session cookie + bcrypt 密碼雜湊）
- 留言列表：按來源、形式（網站／IG 留言 或 WhatsApp 聯絡）、相關網站、狀態、「只睇我嘅」篩選
- 分得清客戶係喺網站／IG 留低，定係撳咗 WhatsApp（或 IG 簡介連結）先至用 WhatsApp 聯絡
- 留言詳情：喺系統內回覆（對話會出現喺擱置／未處理）、改狀態（未處理／處理中／已完成）、改派同事
- 公司 WhatsApp click-to-chat 仍然可以開新分頁，但只係次要；主要路徑係收件箱回覆
- 新留言提示：留言箱同留言詳情打開期間會偵測新留言（28car、官網、Facebook、東榮 IG、WhatsApp 都計），頁面顯示「有新留言」，分頁標題變成 `(3) 內部留言箱`；可選桌面通知
- 可安裝 PWA：加到手機主畫面。設定 VAPID 之後，新留言可以用 Web Push 送到已安裝嘅程式（分頁未開喺前面都得，受瀏覽器同 iOS 限制）
- 同事名單頁（顯示已綁定嘅個人 WhatsApp）
- 管理員：WhatsApp 線路頁（綁定／停用同事個人號）
- JSON API（`/api/...`）方便日後接流動 App 或自動化

### 主要網址

- 網頁：`http://localhost:3001/`
- 健康檢查：`GET /api/health`（包含 `company_whatsapp_url`、`push_enabled`）
- 公開設定：`GET /api/config` → `{ "company_whatsapp_url": "..." }`
- 登入 API：`POST /api/auth/login` `{ "username", "password" }`
- 留言：`GET /api/comments?source=&status=&intake=&origin=&mine=1`（`status=pending` 係未處理＋處理中）
- 新留言游標：`GET /api/comments/updates?since_id=`
- 對話：`GET /api/comments/:id/replies`、`POST /api/comments/:id/replies` `{ "body" }`
- Web Push：`GET /api/push/config`、`POST /api/push/subscribe`、`POST /api/push/unsubscribe`（要登入）
- 改狀態：`POST /api/comments/:id/status`
- 改派：`POST /api/comments/:id/assign`
- 同事：`GET /api/staff`
- WhatsApp 線路（管理員）：`GET /api/whatsapp-lines`、`POST /api/whatsapp-lines`、`POST /api/whatsapp-lines/:id/deactivate`
- 入站 webhook stub：`POST /api/webhooks/whatsapp`（見下面）

## 環境變數

見 `.env.example`：

- `PORT`（預設 `3001`）
- `SESSION_SECRET`（必須改成夠長嘅隨機字串）
- `DATABASE_PATH`（可選，預設 `./data/inbox.db`）
- `COMPANY_WHATSAPP_URL`（公司 WhatsApp **出站** click-to-chat。未設定時預設 `https://api.whatsapp.com/send?phone=85221740001`，即 28car／官網／Facebook 用緊嘅號碼 `85221740001`）
- `WEBHOOK_VERIFY_TOKEN`（入站 webhook 共用密鑰。未設定時 `POST /api/webhooks/whatsapp` 回 503。必須改，唔好提交真實密鑰）
- `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（Web Push。三項都有效先至 `push_enabled`。未設定時 PWA 仍可安裝，但關閉頁面後唔會推送。私鑰唔好提交 git。見下面）

## 新留言提示

留言箱（`/`）同留言詳情（`/comments/:id`）打開期間，頁面會打 `GET /api/comments/updates`（打開後大約 1.5 秒先查一次，之後每 20 秒）。游標係頁面渲染時嘅最新留言 id；之後先寫入資料庫嘅留言先算新。來源包括 28car、東榮官網、Facebook、東榮 IG、WhatsApp。提示文字會寫明係網站留言、IG 留言，定係來自邊個網站嘅 WhatsApp。範圍跟現有登入規則：已登入同事可見全部留言，所以提示都係呢個範圍，唔係淨係派咗畀自己嘅。

未連接真實 WhatsApp／Meta 入站都唔影響呢個提示。Seed、webhook stub，或者任何已經入咗 `comments` 表嘅留言，都會出提示。

- 頁內提示：「有新留言」，附來源、留言者同短摘要。可以「查看」／「查看最新」，或者「重新整理」刷新而家呢頁。
- 分頁標題：有未睇嘅新留言時顯示 `(3) 內部留言箱`。重新整理，或者重新打開留言箱，就會清走。
- 桌面通知：第一次會問一次可唔可以開通知。未訂閱 Web Push 時，只有分頁喺背景先至彈出。已經訂閱推送之後，背景提示改由服務工作程顯示，避免彈兩次。拒絕或者瀏覽器唔支援，頁內提示照常運作。

`GET /api/comments/updates?since_id=19` 回傳：

```json
{
  "latest_id": 21,
  "has_more": false,
  "comments": [
    {
      "id": 21,
      "source": "whatsapp",
      "intake_kind": "whatsapp_click",
      "origin_site": "instagram",
      "author_name": "陳先生",
      "preview": "想問 Alphard",
      "vehicle_ref": null,
      "created_at": "2026-10-27 09:00:00",
      "assignee_staff_id": 2,
      "assignee_name": "李詠詩"
    }
  ]
}
```

唔帶 `since_id` 時只回 `latest_id` 同空陣列，唔會把舊留言當新訊息。`since_id` 必須係非負整數。每次最多回 30 則；如果仲有，`has_more` 係 `true`，頁面會再取。

## 安裝到手機（PWA）同背景通知

登入後嘅網頁可以裝成「東榮內部留言」。裝好、允許通知，而且伺服器設定咗 VAPID，新留言就可以用 **Web Push** 送到手機或電腦，即使個分頁未開喺前面。

開住嘅留言箱**仍然**用頁內「有新留言」同 `(3) 內部留言箱` 標題，呢部分冇拆走。留言箱分頁開住喺前面時，唔再額外彈系統通知，避免同頁內提示重複。

### 點裝

**Android（Chrome）**

1. 用 Chrome 打開網站。正式環境要 HTTPS。
2. 登入。頁面會顯示安裝提示，撳「安裝」。亦可以用選單「安裝應用程式」或「加到主畫面」。
3. 撳「開啟通知」，允許通知。

**iPhone／iPad（要 iOS 16.4 或之後）**

1. 用 **Safari** 打開。唔好指望 Chrome 分頁自己收到推送。
2. 撳底部分享掣 → **加入主畫面**。iOS **唔會**自動彈安裝橫額。
3. 由主畫面打開「東榮留言」，唔好只係留喺 Safari 分頁。
4. 入面撳「開啟通知」。蘋果要求用戶自己撳掣，先可以問通知權限。

**電腦（Chrome／Edge）**

網址列可以安裝。`http://localhost:3001` 可以用嚟示範。

### 邊啲情況收得到

| 情況 | 頁內提示／標題 | 系統通知 |
|------|----------------|----------|
| 留言箱分頁開住喺前面 | 有 | 唔彈，避免同頁內提示重複 |
| 分頁開住但喺背景，未裝 PWA，或者未設定 VAPID | 有 | 有（瀏覽器 Notification，同之前一樣） |
| 已安裝、已允許通知、已設定 VAPID，程式未開喺前面 | 下次打開先見 | 有（Web Push） |
| 未設定 VAPID | 開住嘅頁照常 | 關閉程式之後冇推送 |

推送對象同頁內提示一樣：所有已登入並訂閱嘅同事都會收到，唔係淨係負責人。來源包括 28car、官網、Facebook、東榮 IG、WhatsApp。同事回覆唔會推送。

### 點樣觸發一則推送

新留言**第一次寫入** `comments` 先會推。已存在嘅留言改內容、改狀態、改派，或者 webhook 打重複 `external_id`，都唔會再推。

1. **Webhook stub**（伺服器要開住，而且至少一個瀏覽器已經允許通知並訂閱）：

```bash
curl -sS -X POST http://localhost:3001/api/webhooks/whatsapp \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $WEBHOOK_VERIFY_TOKEN" \
  -d '{"to":"85221740001","from":"85290001111","body":"想問 Alphard 有冇現貨","external_id":"push-demo-1"}'
```

真實 Meta／Glorious WhatsApp 連接呢個改動**未**做。上面只係現有 webhook stub 入庫之後順手推送。

2. **Seed**：`npm run seed` 只會為資料庫之前未有嘅 `source + external_id` 推送。平常重跑現有示範資料唔會當新留言，所以唔會再推。

### 設定 VAPID

金鑰只產生一次，公私鑰要成對留住。私鑰只可以放伺服器。

```bash
npm run vapid:keys
```

將印出嚟嘅值寫入 `.env`（呢個檔已在 `.gitignore`，唔好提交）：

```
VAPID_PUBLIC_KEY=（publicKey）
VAPID_PRIVATE_KEY=（privateKey）
VAPID_SUBJECT=mailto:ops@example.com
```

`VAPID_SUBJECT` 必須係 `mailto:` 或者 `https:` URL。三項都有而且有效，推送先會啟用。改完要重開 `npm start`。`GET /api/health` 嘅 `push_enabled` 係 `true` 就代表伺服器認到金鑰。

訂閱存在 `push_subscriptions`（每位同事最多 10 個裝置；推送服務回 404／410 會刪除過期訂閱）。

### localhost、HTTPS、iOS 限制

呢度寫明邊啲做得到、邊啲做唔到，避免以為裝咗就一定即時響。

- **Service worker 同 Web Push** 喺跑伺服器嗰部機嘅 `localhost` 可以試。一離開本機就要 **HTTPS**，證書要部裝置信任。呢個程式本身唔負責 TLS，正式環境放喺反向代理（Caddy、nginx 等）後面。
- 手機**連唔到**你部電腦嘅 `localhost`（部手機會當係自己）。真手機要試，請用 HTTPS 網址。iPhone 對自簽證書好嚴，未信任就裝唔到，亦收唔到推送。
- **iOS**：只有「加入主畫面」之後嘅程式先有 Web Push（iOS 16.4+）。Safari 分頁關咗就**冇**背景通知。蘋果可以延遲或者合併通知；低電量模式同專注模式都會擋住。訂閱可能過期，下次打開程式會再向伺服器登記。
- **iOS 冇可靠嘅背景輪詢**。而家每 20 秒查新留言，只會喺頁面開住時發生。程式完全關閉之後，唔可以靠輪詢，一定要靠 Web Push，而且要設定 VAPID。
- **Android**：Chrome 安裝後推送一般比 iOS 即時。用戶如果強制停止 Chrome，或者電量優化太進取，仍然可能延遲。
- Service worker **唔會快取留言**。離線打唔開留言箱。佢只係為咗安裝，同埋顯示推送。

### 相關 API

- `GET /api/push/config`（要登入）→ `{ "enabled": true, "public_key": "..." }`。未設定時 `enabled` 係 `false`。
- `POST /api/push/subscribe`（要登入）body 係瀏覽器 `PushSubscription` JSON。
- `POST /api/push/unsubscribe`（要登入）`{ "endpoint": "..." }`。

## 網站留言、IG 留言，同 WhatsApp 聯絡

每則留言有兩個欄位，用來分「喺嗰度留低」同「撳咗連結再用 WhatsApp 搵我哋」：

| 欄位 | 值 | 意思 |
|------|----|------|
| `intake_kind` | `site_comment` | 客戶喺 28car、東榮官網、Facebook 或 Instagram **上面**留言／私訊 |
| `intake_kind` | `whatsapp_click` | 客戶用 WhatsApp 聯絡（直接打嚟，或者由網站／IG 撳過嚟） |
| `origin_site` | `28car` / `glorious_web` / `facebook` / `instagram` / 空 | 只用於 WhatsApp。空＝直接打去公司或同事號 |

`source` 仍然係渠道本身，所以舊有 `?source=whatsapp` 篩選唔使改。

| 客戶做咗咩 | `source` | `intake_kind` | `origin_site` | 畫面 |
|------------|----------|---------------|---------------|------|
| 喺 28car 留低 | `28car` | `site_comment` | 空 | 28car · 網站留言 |
| 喺東榮官網留低 | `glorious_web` | `site_comment` | 空 | 東榮官網 · 網站留言 |
| 喺 Facebook 留低 | `facebook` | `site_comment` | 空 | Facebook · 網站留言 |
| 喺 Instagram 帖文或私訊留低 | `instagram` | `site_comment` | 空 | 東榮 IG · IG 留言 |
| 喺 28car 撳 WhatsApp | `whatsapp` | `whatsapp_click` | `28car` | WhatsApp · 來自28car |
| 喺官網撳 WhatsApp | `whatsapp` | `whatsapp_click` | `glorious_web` | WhatsApp · 來自東榮官網 |
| 喺 Facebook 撳 WhatsApp | `whatsapp` | `whatsapp_click` | `facebook` | WhatsApp · 來自Facebook |
| 喺 IG 撳 WhatsApp，或者簡介連結再入 WhatsApp | `whatsapp` | `whatsapp_click` | `instagram` | WhatsApp · 來自東榮 IG |
| 直接打去公司 WhatsApp | `whatsapp` | `whatsapp_click` | 空 | WhatsApp · 直接 WhatsApp |

東榮 IG 係獨立來源，**唔會**埋喺東榮官網入面。

Instagram 簡介（link in bio）嘅長連結 `l.instagram.com` 展開之後係：

`http://glorious.hk/?utm_source=ig&utm_medium=social&utm_content=link_in_bio`

即使網域係 `glorious.hk`，只要 `utm_source=ig`（或 `utm_content=link_in_bio`），WhatsApp 入站會標 `origin_site=instagram`。冇呢啲參數、淨係 `glorious.hk` 先至算東榮官網。

列表可以同時篩：

- `intake=site_comment` 或 `intake=whatsapp_click`
- `origin=28car|glorious_web|facebook|instagram|direct`（`direct`＝直接 WhatsApp）
- `status=pending`＝擱置／未處理（`open`＋`in_progress`）。回覆之後如果原本係未處理，會改做處理中，**仍然留喺呢個清單**，唔會標已完成。

## 在系統內回覆

留言詳情有對話同「發送回覆」。列表「內容」會顯示最新一則同事回覆，擱置／未處理都睇到。

`POST /api/comments/:id/replies`（要登入）

```json
{ "body": "星期六可以嚟葵涌陳列室睇。" }
```

成功 `201`：

```json
{
  "reply": {
    "id": 1,
    "comment_id": 12,
    "staff_id": 2,
    "staff_name": "李詠詩",
    "direction": "outbound",
    "body": "星期六可以嚟葵涌陳列室睇。",
    "delivery_status": "stub",
    "created_at": "2026-10-28 02:00:00"
  },
  "comment": { "id": 12, "status": "in_progress", "reply_count": 1 }
}
```

`GET /api/comments/:id/replies` 回 `{ "replies": [ ... ] }`。`GET /api/comments/:id` 同時有 `comment` 同 `replies`。

`delivery_status`：

| 值 | 意思 |
|----|------|
| `stub` | 已寫入收件箱，並排入示範佇列。**未**呼叫 Meta、Glorious、28car、官網、Facebook 或 Instagram |
| `stored` | 只儲存，未嘗試發送（而家嘅同事回覆唔用呢個） |
| `failed` | 出站 adapter 回報失敗（stub 而家唔會回失敗） |

同事回覆**唔會**當新留言去推送或輪詢提示。新留言提示仍然只係新入庫嘅客戶留言。

公司 WhatsApp 同同事 WhatsApp 按鈕仍然開新分頁（click-to-chat），預填文字會寫明係網站留言、IG 留言，定係來自邊個網站嘅 WhatsApp。

## 公司 WhatsApp click-to-chat

留言列表同留言詳情有 **WhatsApp** 按鈕（次要），開新分頁去公司 click-to-chat。有資料時會用 `text` 預填一段短訊，包含來源、車輛編號同留言摘要。

`GET /api/config`（同 `GET /api/health`）回傳 `company_whatsapp_url`，前端唔使自己硬編碼呢條連結。

若該留言負責人已綁定啟用中嘅個人線路，會再顯示 **同事 WhatsApp**，打去該同事嘅號碼（同樣只係開新分頁，唔會經 API 發送）。

## WhatsApp 線路同派單

表 `whatsapp_lines`：`phone_e164`（只留數字，例如 `85221740001`）、`display_label`、`kind`（`company` 或 `staff`）、`staff_id`（同事線路必填）、`is_active`。

Seed 會寫入公司總機：

| 號碼 | 名稱 | 類型 |
|------|------|------|
| `85221740001` | 東榮總機 | `company`（`staff_id` 為空） |

管理員頁 `/whatsapp-lines`（導航「WhatsApp 線路」）可以：

- 睇全部線路
- 綁定同事個人 Business WhatsApp（揀同事 + 號碼；可選顯示名稱）
- 停用線路（停用後再打去該號碼唔會再按原規則派單）

已停用嘅同事號碼可以再綁定（會重新啟用）。公司總機號碼唔可以綁成個人線路。每位同事同時只可以有一條啟用中嘅個人線路。

### 入站規則

`routeWhatsAppInbound({ toPhone, fromPhone, body, externalId })`（`src/services/whatsapp.ts`）：

1. **同事個人號**（`kind = staff` 而且啟用）→ 該對話／留言自動派畀綁定嘅同事。
2. **公司總機 `85221740001`** → 用現有自動派單：**未完成（open + in_progress）最少嘅在職同事優先，同數則 staff id 較細**。
3. **未知或已停用號碼** → 仍然入庫（來源 `whatsapp`、狀態未處理），但**未派單**，並喺伺服器 log 記一筆。綁定同事已停用時同樣未派。

有 `external_id` 時用佢做冪等鍵（webhook 重試唔會開新留言，亦唔會改走公司總機已派嘅同事）。冇 `external_id` 時，同一對「收件線路 + 寄件人」合成一條對話，新內容會附加。

本地示範（唔使開伺服器）：

```bash
npm run demo:whatsapp-route
```

### Webhook stub（尚未連接 Meta／Glorious）

真實 WhatsApp Business／Glorious 連接**稍後先做**。而家唔會呼叫任何 WhatsApp API，`src/adapters/whatsapp.ts` 嘅 `fetchInboundChats` 仍然係空 stub。

要試派單，可以打：

`POST /api/webhooks/whatsapp`

Header：`X-Webhook-Token: <WEBHOOK_VERIFY_TOKEN>`（或 `Authorization: Bearer <token>`）

```json
{
  "to": "85221740001",
  "from": "85291234567",
  "body": "想問 Alphard",
  "external_id": "demo-1",
  "origin_site": "instagram"
}
```

`origin_site` 可選：`28car`、`glorious_web`、`facebook`、`instagram`（`ig` 會收成 `instagram`）。唔填就係直接 WhatsApp。亦可以用 `referral.source_url`，例如簡介連結：

```json
{
  "to": "85221740001",
  "from": "85291234567",
  "body": "簡介連結入嚟",
  "external_id": "demo-ig-bio",
  "referral": {
    "source_url": "http://glorious.hk/?utm_source=ig&utm_medium=social&utm_content=link_in_bio"
  }
}
```

上面呢則會入庫為 `source=whatsapp`、`intake_kind=whatsapp_click`、`origin_site=instagram`，唔會變成東榮官網留言。`l.instagram.com/?u=` 會先展開再判斷。

`to`／`from` 可以帶 `+`、空格或橫線，程式會收成數字。新寫入嘅留言（唔係重複 `external_id`）會同時嘗試 Web Push，見下面「安裝到手機」。同事喺收件箱回覆唔會推送。

亦接受簡化版 Meta Cloud API：`entry[].changes[].value.metadata.display_phone_number` 加 `messages[]`（`text.body`）。只有 `statuses`、冇文字訊息時會回 `{ "ok": true, "ignored": true }`，方便日後 Meta 驗證。

Meta 訂閱驗證（稍後先用）：

`GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WEBHOOK_VERIFY_TOKEN>&hub.challenge=<challenge>`

Token 唔啱回 401／403。環境變數未設定回 503。**唔好將真實 token 寫入 git。**

## 資料庫

SQLite（`better-sqlite3`），檔案喺 `data/inbox.db`（已加入 `.gitignore`）。

派單規則（seed／未指派留言／公司 WhatsApp 總機）：**未完成（open + in_progress）最少嘅同事優先，同數則 staff id 較細者**。

如果資料庫係舊版本（未有 `whatsapp`、未有 `instagram`，或者未有 `intake_kind`／`origin_site`），啟動時會自動重建 `comments` 表。原有留言 id、內容同負責人都保留。舊嘅網站留言會標成 `site_comment`；舊嘅 WhatsApp 會標成 `whatsapp_click`，`origin_site` 留空（直接 WhatsApp）。

同事回覆喺 `comment_replies`（`staff_id`、`body`、`direction=outbound`、`delivery_status`）。

## 計劃中嘅真來源（出站而家全部係 stub）

`src/adapters/twentyeightcar.ts`、`glorious-web.ts`、`facebook.ts`、`instagram.ts` 暫時只係 stub，之後再接登入／API／webhook。Instagram 未接 Graph API。

`src/adapters/whatsapp.ts` 同樣**未**連接 Meta Cloud API 或 Glorious WhatsApp Business API。而家只係：

- 公司號碼 click-to-chat（`COMPANY_WHATSAPP_URL`）
- 線路綁定同 `routeWhatsAppInbound` 派單
- `POST /api/webhooks/whatsapp` stub，等之後先至接真實 payload
- `queueOutboundReply`：同事回覆寫入資料庫之後標 `delivery_status=stub`，**唔會**打去 WhatsApp

真實發送要等邊條線先駁：

| 客戶所在 | 而家 | 之後先至接 |
|----------|------|------------|
| 公司／同事 WhatsApp，包括由網站或 IG 撳過嚟 | 收件箱儲存，標 stub | Meta Cloud API **或** Glorious WhatsApp Business API |
| 28car 網站留言 | 收件箱儲存，標 stub | 28car |
| 東榮官網留言 | 收件箱儲存，標 stub | glorious.hk |
| Facebook 留言 | 收件箱儲存，標 stub | Facebook Graph API |
| 東榮 IG 留言／私訊 | 收件箱儲存，標 stub | Instagram Graph API |

未駁之前，收件箱回覆同列表都用得。click-to-chat 仍然可以人手開 WhatsApp 網頁。

## 授權

UNLICENSED · 東榮汽車內部使用
