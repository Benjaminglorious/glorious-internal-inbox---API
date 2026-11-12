# 東榮汽車 · 內部留言系統（glorious-internal-inbox）

公司**內部專用**網頁，畀同事登入後處理客戶留言／查詢：

| 來源 | 網址 | 程式碼識別 | 畫面 |
|------|------|------------|------|
| 28car | https://www.28car.com | `28car` | 28car |
| 東榮官網 | https://glorious.hk/cn2/ | `glorious_web` | 東榮官網 |
| Facebook | https://www.facebook.com/GloriousMotors | `facebook` | Facebook |
| 東榮 Instagram | 簡介連結會去 `glorious.hk/?utm_source=ig` | `instagram` | 東榮 IG |
| WhatsApp | 公司總機 `85221740001` 同已綁定嘅同事個人號 | `whatsapp` | WhatsApp |
| 公司電郵 | `gloriousinformation@gmail.com` | `email` | email 留言／這是email的留言 |

而家用**示範資料**。官網抓取同出站仍然係 stub。Facebook／Instagram 入站用 Meta webhook；出站有 Page token 就打 Graph。28car 車盤同留言板可以入庫；即時連去 28car 要可輪換代理而且旗標先至會開，預設唔出網絡。公司 WhatsApp 總機回覆會打 Cloud API（要設定 token）。

> ⚠️ 呢個系統只供東榮內部同事使用，唔應公開喺互聯網冇保護咁部署。

## 需求

- Node.js 20+
- npm

## 快速開始

```bash
cp .env.example .env   # 改 SESSION_SECRET，以及 WEBHOOK_VERIFY_TOKEN（要用 webhook 先至需要）
npm install
npm run seed           # 本地：15 位同事 + 示範留言 + 公司 WhatsApp 總機
npm start              # http://localhost:3001
```

只寫同事、唔寫示範留言（同正式環境第一次啟動一樣）：

```bash
npm run seed:staff
```

清走已經寫入嘅示範留言（保留同事、`wamid.*` 同 seed 清單以外嘅 28car 留言）：

```bash
npm run clear:demo
```

開發模式（自動重載）：

```bash
npm run dev
```

## Render（正式：Postgres，唔再靠 SQLite disk）

服務：`glorious-internal-inbox`。資料庫同 web service 都放 **Singapore**。Region 建立之後改唔到；唔好開咗喺另一個 region 先至發現連唔到內網。

1. Dashboard → New → **PostgreSQL**。Region 揀 **Singapore**。正式收件箱要用付費 Postgres。免費 Postgres 大約 30 日後會過期，過期就會冇咗真實 WhatsApp 對話。
2. 建好之後開 **Connect → Internal Database URL**（同一個 workspace、同一個 region 先至通私網）。唔好用 External URL 做 web service 嘅連線。唔好把呢條字串提交 git。
3. Web service Environment 加 `DATABASE_URL` = 上面條 Internal Database URL。`POSTGRES_URL` 都認，但有 `DATABASE_URL` 就用佢。
4. **Build command：** `npm install`
5. **Start command：** `npm start`  
   唔好再用 `npm run seed && npm start`。`NODE_ENV=production`（Render 預設）或者連住 Render Postgres 時，`npm run seed` 會直接退出，**唔會**寫示範留言。舊 start command 會令 deploy 失敗，直到改成 `npm start`。

`npm start` 會做三件事：

- 建立／對齊 schema（comments、replies、staff、whatsapp_lines、push、28car）
- **staff 表係空**先至寫入全部同事名單同公司總機 `85221740001`（新帳號先用示範密碼；已有 `password_hash` 唔覆寫）
- **已有同事**（包括 Render Postgres）啟動時確保 Benjamin（`benjamin`）同 Vivian（`vivian`）係在職管理員：未有就新增並用示範密碼；用戶名不分大小寫，或者顯示名係 Benjamin／Vivian（或 Vivian …），就升級同一列而唔另開帳號，唔改已有密碼。唔會降 Tony、Benjamin、Eddie，亦唔會改其他同事嘅角色
- **唔會**寫示範 Facebook／IG／WhatsApp／28car 留言或觀察車盤

本地想要示範資料先至 `npm run seed`（或 `npm run seed:demo`）。正式環境要一次過對齊成份名單（姓名／角色／在職，唔改密碼，唔加留言）先至用 Render Shell：`npm run seed:staff`。只係補 Benjamin 同 Vivian 嘅話，下次 `npm start` 已經會做。

如果舊 deploy 已經把示範留言寫入而家呢個 Postgres：Shell 跑 `npm run clear:demo`，或者管理員登入之後喺網站網域執行：

```js
fetch("/api/admin/clear-demo", { method: "POST" }).then((r) => r.json()).then(console.log)
```

清除之後淨係剩真實收件箱：Meta `wamid.*`、其他唔喺 seed 清單嘅留言（包括 Tony 要留嘅 28car 留言板）、同事帳號。程式**唔會**因為 `external_id` 唔似 `wamid.` 就整表刪走。觀察車盤（`sync_origin=observed`）同種子車盤訊息 `observed-seller-whatsapp`／`demo-buyer` 會一併刪；已經同步過、`sync_origin` 唔再係 `observed` 嘅車盤會留低。

`npm start` 用 `tsx` 跑 TypeScript。`tsx` 喺 `dependencies`，所以 `NODE_ENV=production` 時 `npm install` 唔會漏咗佢。`app.listen(PORT, "0.0.0.0")` 聽所有網絡介面，Render 代理夠用。

`NODE_ENV=production` 時 session cookie 會加 `Secure`，session 寫入同一個 Postgres（唔再靠會消失嘅 `data/sessions.db`）。程式已設 `trust proxy`。請設定夠長嘅 `SESSION_SECRET`。

免費 Web Service 大約 15 分鐘冇流量會休眠，下次請求要等喚醒。休眠唔會清 Postgres。未設定 `DATABASE_URL` 時先至用 SQLite `./data/inbox.db`；Render 檔案系統係臨時嘅，正式環境唔好靠佢。免費方案亦掛唔到 persistent disk。

本地強制用 SQLite（即使 shell 有 `DATABASE_URL`）：`INBOX_DB=sqlite`。

## 預設登入（示範）

**全部同事共用示範密碼（正式環境必須更改）：**

```
Glorious2026!
```

例子：

| 姓名 | 帳號 | 角色 |
|------|------|------|
| Tony Chan | `tony` | 管理員 |
| Eddie Lau | `eddie` | 管理員 |
| Benjamin | `benjamin` | 管理員（同 Tony：唔參與公司線自動派單） |
| Vivian | `vivian` | 管理員（同 Tony、Benjamin：唔參與公司線自動派單） |
| Wing Cheng | `wing` | 同事 |
| Jason Cheng | `jason` | 同事 |

收藏、而家登入唔到（`active=0`，列仍然保留）：`kaixin` `ming` `mei` `ho` `yan` `chun` `sze` `kit` `yuki`。

登入之後可以喺頁頂「改密碼」改自己嘅密碼。重新跑 `npm run seed` 會更新同事姓名、角色同在職狀態，但唔會覆寫已經存在嘅 `password_hash`（新插入嘅帳號先至用示範密碼）。收藏同事都唔會被強制改密碼。

## 權限

| 角色 | 登入 | 睇留言 | 回覆／改狀態 | 改派 |
|------|------|--------|----------------|------|
| 管理員（`tony`、`eddie`、`benjamin`、`vivian`） | 可以 | 全部，包括未派 | 任何一則 | 可以 |
| 在職同事（`wing`、`jason`） | 可以 | 只係 `assignee_staff_id` 等於自己 | 只係自己負責嗰啲 | 唔可以（403） |
| 收藏（`active=0`） | 唔可以 | — | — | — |

在職同事同管理員都只可以改**自己**嘅密碼（`/password`）。冇人可以喺呢個頁面改其他人嘅密碼。

未派嘅留言只係管理員睇到。網頁（`/`、`/comments/:id`、回覆同狀態表單）同 JSON API（列表、詳情、回覆、改狀態、`/api/comments/updates`）用同一套規則。在職同事唔可以靠輪詢或者推送睇到其他人嘅留言內容。

煙霧測試：`npm run demo:staff-visibility`、`npm run demo:change-password`、`npm run demo:staff-time`

## 功能

- 登入／登出（session cookie + bcrypt 密碼雜湊）
- 改密碼：登入後自己改，要對現有密碼；成功之後維持登入
- 留言列表：按來源、形式（網站／IG 留言 或 WhatsApp 聯絡）、相關網站、狀態、「只睇我嘅」篩選
- 分得清客戶係喺網站／IG 留低，定係撳咗 WhatsApp（或 IG 簡介連結）先至用 WhatsApp 聯絡
- 留言詳情：喺系統內回覆（對話會出現喺擱置／未處理）、改狀態（未處理／處理中／已完成）。管理員可以改派；在職同事唔可以
- 公司 WhatsApp click-to-chat 仍然可以開新分頁，但只係次要；主要路徑係收件箱回覆
- 新留言提示：留言箱同留言詳情打開期間會偵測新留言（28car、官網、Facebook、東榮 IG、WhatsApp 都計），頁面顯示「有新留言」，分頁標題變成 `(3) 內部留言箱`；可選桌面通知
- 可安裝 PWA：加到手機主畫面。設定 VAPID 之後，新留言可以用 Web Push 送到已安裝嘅程式（分頁未開喺前面都得，受瀏覽器同 iOS 限制）
- 同事名單頁（顯示已綁定嘅個人 WhatsApp）
- 管理員：WhatsApp 線路頁（綁定／停用同事個人號）
- JSON API（`/api/...`）方便日後接流動 App 或自動化
- 時間：網頁同同事 API 顯示香港時間（`Asia/Hong_Kong`，HKT，UTC+8）。資料庫 `created_at`／`updated_at` 仍然係 UTC 文字（`YYYY-MM-DD HH:MM:SS`）。網頁相對時間（剛剛、分鐘前、小時前、昨天）按香港日曆計。28car 車盤日期同留言板時間係網站上嘅香港鐘面，顯示時唔會再加 8 小時

### 主要網址

- 網頁：`http://localhost:3001/`
- 健康檢查：`GET /api/health`（包含 `company_whatsapp_url`、`push_enabled`、`time_zone`、`ts_hkt`。`ts` 仍然係 UTC ISO）
- 公開設定：`GET /api/config` → `{ "company_whatsapp_url": "..." }`
- 登入 API：`POST /api/auth/login` `{ "username", "password" }`
- 改密碼：`GET /password`、`POST /password`（要登入；欄位 `current_password`、`new_password`、`confirm_password`）
- 改密碼 API：`POST /api/auth/password`（要登入，欄位同上；只改 session 入面嗰位同事）
- 留言：`GET /api/comments?source=&status=&intake=&origin=&mine=1`（`status=pending` 係未處理＋處理中）
- 新留言游標：`GET /api/comments/updates?since_id=`
- 對話：`GET /api/comments/:id/replies`、`POST /api/comments/:id/replies` `{ "body" }`
- Web Push：`GET /api/push/config`、`POST /api/push/subscribe`、`POST /api/push/unsubscribe`（要登入）
- 改狀態：`POST /api/comments/:id/status`
- 改派（只限管理員）：`POST /api/comments/:id/assign`
- 同事：`GET /api/staff`
- WhatsApp 線路（管理員）：`GET /api/whatsapp-lines`、`POST /api/whatsapp-lines`、`POST /api/whatsapp-lines/:id/deactivate`
- 入站 webhook：`POST /api/webhooks/whatsapp`（WhatsApp Cloud API 收件；簽名規則同 Meta Page／IG）
- 網站／FB／IG 入站：`POST /api/webhooks/site-comment`（以及 `/28car`、`/glorious-web`、`/facebook`、`/instagram` 別名）
- Meta Callback：`GET|POST /api/webhooks/meta`（hub 驗證 + Page／IG payload 骨架）

## 環境變數

見 `.env.example`：

- `PORT`（預設 `3001`）
- `SESSION_SECRET`（必須改成夠長嘅隨機字串）
- `DATABASE_URL` 或 `POSTGRES_URL`（正式環境。Render Internal Database URL。有呢個就用 PostgreSQL，唔再打開 SQLite。唔好提交真實字串）
- `DATABASE_PATH`（只係本地 SQLite。未設定 `DATABASE_URL` 時預設 `./data/inbox.db`）
- `INBOX_DB=sqlite`（可選。強制本地檔案，忽略 `DATABASE_URL`。示範腳本會自己設）
- `ALLOW_DEMO_SEED=1`（可選，危險。先至可以喺 `NODE_ENV=production` 或 Render Postgres 寫示範留言。正式環境唔好設）
- `COMPANY_WHATSAPP_URL`（公司 WhatsApp **出站** click-to-chat。未設定時預設 `https://api.whatsapp.com/send?phone=85221740001`，即 28car／官網／Facebook 用緊嘅號碼 `85221740001`）
- `WEBHOOK_VERIFY_TOKEN`（入站 webhook 共用密鑰：WhatsApp、site-comment、Meta hub.verify。未設定回 503。必須改，唔好提交真實密鑰）
- `META_APP_ID`、`META_APP_SECRET`、`META_PAGE_ID`、`META_PAGE_ACCESS_TOKEN`、`META_IG_BUSINESS_ACCOUNT_ID`、`META_GRAPH_VERSION`（Page token 用嚟發 Facebook／Instagram 回覆，**唔**用嚟發 WhatsApp。未設定 token 時 FB／IG 回覆標 `failed`。Callback：`/api/webhooks/meta`。見下面「Facebook／Instagram 出站」）
- `WHATSAPP_ACCESS_TOKEN`（**Render 必須設定**。WhatsApp Cloud API token，用來發公司總機回覆。未設定時公司線回覆標 `failed`，唔會當成功。唔好提交真實值）
- `WHATSAPP_PHONE_NUMBER_ID`（**Render 建議設定**。公司總機 `85221740001` 嘅 phone number id。未設定時代碼用 `241163761376752`）
- `WHATSAPP_GRAPH_VERSION`（可選。未設定用 `v21.0`）
- `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（Web Push。三項都有效先至 `push_enabled`。未設定時 PWA 仍可安裝，但關閉頁面後唔會推送。私鑰唔好提交 git。見下面）
- `GLORIOUS_EMAIL_ADDRESS`（公司郵箱。留空等於 `gloriousinformation@gmail.com`。呢個唔係密鑰）
- `GLORIOUS_EMAIL_APP_PASSWORD`（Gmail 應用程式密碼。有呢個就會收信同用呢個郵箱回信。留空而且未設定下面三項 OAuth，就唔會連接 Gmail。唔好提交 git）
- `GLORIOUS_EMAIL_OAUTH_CLIENT_ID`、`GLORIOUS_EMAIL_OAUTH_CLIENT_SECRET`、`GLORIOUS_EMAIL_OAUTH_REFRESH_TOKEN`（可選。冇應用程式密碼時先用。三項都要齊。Scope 用 `https://mail.google.com/`。唔好提交 git）
- `GLORIOUS_EMAIL_POLL_MS`（可選。預設 `120000`，即 2 分鐘。程式會夾喺 60 秒到 15 分鐘）
- `GLORIOUS_EMAIL_LOOKBACK_DAYS`（可選。預設 `14`，最大 `90`。只係第一次，或者 Gmail 重建 UID 之後，先至用嚟補舊信）
- `GLORIOUS_EMAIL_IMAP_HOST`、`GLORIOUS_EMAIL_IMAP_PORT`、`GLORIOUS_EMAIL_SMTP_HOST`、`GLORIOUS_EMAIL_SMTP_PORT`（可選。預設 `imap.gmail.com:993` 同 `smtp.gmail.com:465`）

## 新留言提示

留言箱（`/`）同留言詳情（`/comments/:id`）打開期間，頁面會打 `GET /api/comments/updates`（打開後大約 1.5 秒先查一次，之後每 20 秒）。游標係頁面渲染時嘅最新留言 id；之後先寫入資料庫嘅留言先算新。來源包括 28car、東榮官網、Facebook、東榮 IG、WhatsApp、公司電郵。公司電郵會寫「這是email的留言」。提示文字會寫明係網站留言、IG 留言、電郵，定係來自邊個網站嘅 WhatsApp。範圍跟登入角色：管理員會見到全部新留言（包括未派）；在職同事只會見到派咗畀自己嘅。其他人嘅留言內容唔會出現喺提示。

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
      "created_at": "2026-10-27 17:00:00 HKT",
      "assignee_staff_id": 2,
      "assignee_name": "Wing Cheng"
    }
  ]
}
```

唔帶 `since_id` 時只回 `latest_id` 同空陣列，唔會把舊留言當新訊息。`since_id` 必須係非負整數。每次最多回 30 則；如果仲有，`has_more` 係 `true`，頁面會再取。回應會帶 `time_zone: "Asia/Hong_Kong"`。`created_at` 係香港鐘面（上面例子對應資料庫 UTC `2026-10-27 09:00:00`），唔係再儲存多一次。

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

推送對象同頁內提示一樣：已訂閱嘅管理員收到全部新留言（包括未派）；在職同事只收到派咗畀自己嘅。收藏同事唔會收到。來源包括 28car、官網、Facebook、東榮 IG、WhatsApp。同事回覆唔會推送。

### 點樣觸發一則推送

新留言**第一次寫入** `comments` 先會推。已存在嘅留言改內容、改狀態、改派，或者 webhook 打重複 `external_id`，都唔會再推。

1. **Webhook stub**（伺服器要開住，而且至少一個瀏覽器已經允許通知並訂閱）：

```bash
curl -sS -X POST http://localhost:3001/api/webhooks/whatsapp \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: $WEBHOOK_VERIFY_TOKEN" \
  -d '{"to":"85221740001","from":"85290001111","body":"想問 Alphard 有冇現貨","external_id":"push-demo-1"}'
```

上面係可選 `X-Webhook-Token` 嘅 stub，入庫之後順手推送。Meta 正式推送用 `X-Hub-Signature-256`，唔使呢個 header。公司總機回覆出站見下面「公司 WhatsApp 出站」。

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

Meta Cloud 嘅 `messages[].referral` 唔止睇 `source_url`。有 Instagram 訊號先標 `origin_site=instagram`：

- `source_url`（包括 `utm_source=ig`、`utm_content=link_in_bio`、`l.instagram.com`、`instagram.com`、`ig.me`、`cdninstagram.com`）
- `source_type` 含 `instagram`，或者獨立字 `ig`（例如 `ig_profile`）。文件入面嘅 `ad`／`post` 唔當平台
- `headline`、`body`、`welcome_message`、`source_id`、`image_url`／`video_url`／`thumbnail_url` 入面嘅 IG permalink 或網址
- 訊息 `context.referral`（回覆／歡迎訊息帶埋嘅 referral）

`media_type` 只係 `image` 或 `video`、再加上 `ctwa_clid`，但冇上面嘅平台訊號，就唔會估成 Instagram（Facebook 廣告都有呢啲欄）。完全冇 referral、或者 referral 係空物件，維持直接 WhatsApp。客戶訊息正文提到 Instagram 都唔會改來源。

限制：Instagram 主頁（個人檔）嘅 WhatsApp 掣，Meta 有時唔附 referral。冇訊號就標唔到東榮 IG，畫面會繼續係「直接 WhatsApp」。已經入庫、又冇留低原始 webhook 嘅舊訊息唔能夠事後補標。

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
    "staff_name": "Wing Cheng",
    "direction": "outbound",
    "body": "星期六可以嚟葵涌陳列室睇。",
    "delivery_status": "stub",
    "created_at": "2026-10-28 10:00:00 HKT"
  },
  "comment": { "id": 12, "status": "in_progress", "reply_count": 1 }
}
```

`GET /api/comments/:id/replies` 回 `{ "replies": [ ... ] }`。`GET /api/comments/:id` 同時有 `comment` 同 `replies`。回覆嘅 `created_at` 同樣係香港時間。上面 `2026-10-28 10:00:00 HKT` 對應資料庫 UTC `2026-10-28 02:00:00`。

`delivery_status`：

| 值 | 意思 |
|----|------|
| `sent` | 公司 WhatsApp 已呼叫 Cloud API，而且 Graph 回傳訊息 id |
| `stub` | 已寫入收件箱，未呼叫外部 API。同事個人 WhatsApp、官網回覆用呢個。Facebook／Instagram 缺設定時用 `failed`，唔再用 `stub` |
| `stored` | 只儲存，未嘗試發送（而家嘅同事回覆唔用呢個） |
| `failed` | 公司 WhatsApp 應該發送但未成功（缺 token、冇客戶號碼、Graph 錯誤）。原因寫喺回覆嘅 `delivery_error`，畫面會顯示 |

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
2. **公司總機 `85221740001`** → 按固定輪流派畀下一位在職同事：**Eddie → Wing → Jason → 其餘在職同事（按 staff id，排喺 Jason 後面）**。唔會計未完成（open + in_progress）數量。游標存在 `auto_assign_state`，重啟同多個 instance 都沿用上一位。**Tony、Benjamin、Vivian 唔參與自動派單**（管理員仍然可以人手改派畀佢哋）。Eddie 都係管理員，但仍然參與。如果上一位已停用、被排除或不存在，就由次序入面下一位仍然符合資格嘅同事接。未有游標時由 Eddie（或第一位符合資格嘅同事）開始。
3. **未知或已停用號碼** → 仍然入庫（來源 `whatsapp`、狀態未處理），但**未派單**，並喺伺服器 log 記一筆。綁定同事已停用時同樣未派。

有 `external_id` 時用佢做冪等鍵（webhook 重試唔會開新留言，亦唔會改走公司總機已派嘅同事）。冇 `external_id` 時，同一對「收件線路 + 寄件人」合成一條對話，新內容會附加。

本地示範（唔使開伺服器）：

```bash
npm run demo:whatsapp-route
npm run demo:whatsapp-outbound
```

### WhatsApp 入站（Meta Cloud API，只收件）

Callback URL（生產）：

`https://glorious-internal-inbox.onrender.com/api/webhooks/whatsapp`

`POST /api/webhooks/whatsapp` 嘅驗證同 Page／Instagram（`POST /api/webhooks/meta`）一樣：

- 有 `META_APP_SECRET` 時必須帶正確 `X-Hub-Signature-256`（唔啱回 401）。未設定 secret 就跳過簽名。
- Meta 推送**唔會**帶 `X-Webhook-Token`。冇呢個 header（亦冇 Bearer）都可以入站。
- 如果請求有 `X-Webhook-Token` 或 `Authorization: Bearer`，就必須對照 `WEBHOOK_VERIFY_TOKEN`（唔啱回 401）。本地 stub／測試可以繼續帶 token。
- `WEBHOOK_VERIFY_TOKEN` 未設定時 POST 回 503。

入站唔會下載媒體。`fetchInboundChats` 仍然係空 stub。同事回覆公司總機（留言有客戶 `wa_id`）會打 Cloud API 出站；詳見下面「公司 WhatsApp 出站」。同事個人線路仍然只標 `stub`。

要試派單，可以打：

`POST /api/webhooks/whatsapp`

Header（可選）：`X-Webhook-Token: <WEBHOOK_VERIFY_TOKEN>`（或 `Authorization: Bearer <token>`）

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

冇 `source_url`、但 `source_type` 係 `instagram` 或 `ig_profile`，又或者 `body`／`welcome_message`／圖片網址係 Instagram permalink，同樣標 `instagram`。例如：

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "metadata": { "display_phone_number": "85221740001" },
        "messages": [{
          "from": "85291234567",
          "id": "wamid.IG-PROFILE",
          "type": "text",
          "text": { "body": "Test" },
          "referral": { "source_type": "instagram", "source_id": "17841405822304914" }
        }]
      }
    }]
  }]
}
```

空 `referral`、或者只有 `source_type: "ad"`、`ctwa_clid`、`media_type` 而冇平台網址，入庫 `origin_site` 留空（直接 WhatsApp）。

`to`／`from` 可以帶 `+`、空格或橫線，程式會收成數字。新寫入嘅留言（唔係重複 `external_id`）會同時嘗試 Web Push，見下面「安裝到手機」。同事喺收件箱回覆唔會推送。

亦接受 Meta WhatsApp Business Account 嘅 Incoming Message：`object=whatsapp_business_account`，`entry[].changes[].value.metadata.display_phone_number` 對線路（公司總機 `85221740001`），`messages[].text.body` 入庫。只有 `statuses`、或者冇文字嘅媒體訊息，會回 `{ "ok": true, "ignored": true }`（收件，唔下載媒體）。

訂閱驗證：

`GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WEBHOOK_VERIFY_TOKEN>&hub.challenge=<challenge>`

Verify token 唔啱回 403。環境變數未設定回 503。**唔好將真實 token 或 app secret 寫入 git。**

### 網站／FB／IG 留言入站（`site-comment`）

CMS、聯絡表，或者人手腳本可以用：

`POST /api/webhooks/site-comment`

Header：`X-Webhook-Token: <WEBHOOK_VERIFY_TOKEN>`（或 `Authorization: Bearer <token>`）

```json
{
  "source": "glorious_web",
  "external_id": "form-1001",
  "author_name": "陳先生",
  "body": "想預約參觀陳列室",
  "vehicle_ref": "Alphard"
}
```

`source`：`28car`、`glorious_web`、`facebook`、`instagram`（別名 `fb`／`ig`／`gw`／`web`／`glorious`）。會入庫為 `intake_kind=site_comment`、`origin_site` 空，並用同一套輪流次序派單（唔計未完成數）。同一 `(source, external_id)` 再打會更新內容，唔會開新列。

路徑別名（body 可以唔傳 `source`）：

- `POST /api/webhooks/site-comment/28car`
- `POST /api/webhooks/site-comment/glorious-web`
- `POST /api/webhooks/site-comment/facebook`
- `POST /api/webhooks/site-comment/instagram`

煙霧測試：`npm run demo:site-comment`

### Meta Facebook／Instagram Callback（骨架）

Callback URL（生產）：

`https://glorious-internal-inbox.onrender.com/api/webhooks/meta`

Verify token = `WEBHOOK_VERIFY_TOKEN`。

`GET /api/webhooks/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` 會回 challenge。

`POST /api/webhooks/meta`：認得 Page `feed` 留言、Messenger `messaging`、Instagram `comments`／私訊時，會 `upsertSiteComment`（`facebook` 或 `instagram`）。公開留言寫 `meta_surface=comment` 同留言者 id；私訊寫 `meta_surface=message`、`external_id` 用 mid、`meta_sender_id` 用 PSID／IGSID。狀態回呼等會 `{ "ok": true, "ignored": true }`。有設 `META_PAGE_ID` 或 `META_IG_BUSINESS_ACCOUNT_ID` 時，專頁／IG 帳號自己發出嘅留言同私訊唔入庫。有設 `META_APP_SECRET` 就驗證 `X-Hub-Signature-256`；未設就跳過。

**仍然需要 Tony／同事喺 Meta Developer Console 建立 App、訂閱欄位、完成 App Review，並將 Page 指派俾可以回覆嘅人。** 出站見下面「Facebook／Instagram 出站」。WhatsApp Cloud 收件用 `/api/webhooks/whatsapp`，POST 驗證同上面一樣（`X-Hub-Signature-256`；自訂 token 只係帶咗先至核對）。公司總機回覆出站用下面嘅 `WHATSAPP_ACCESS_TOKEN`，唔用 Page token。

官網：最穩係 CMS 或聯絡表 webhook 打去 `site-comment`。28car 車盤同留言板見下面「28car 車盤同留言板」。

## 資料庫

本地預設 SQLite（`better-sqlite3`），檔案喺 `data/inbox.db`（已加入 `.gitignore`）。設定 `DATABASE_URL` 或 `POSTGRES_URL` 就改用 PostgreSQL（`pg`，參數化查詢）。正式環境用 Render Postgres，見上面「Render」。兩種庫都係開機時對齊 schema。

派單規則（seed／未指派留言／公司 WhatsApp 總機／網站留言）：**固定輪流，唔計未完成數**。次序係 **Eddie → Wing → Jason → 其餘 `active=1` 同事（按 staff id，排喺 Jason 後面）**。上一位寫入 `auto_assign_state`（`last_staff_id`、`last_username`）。**Tony（`username=tony`）、Benjamin（`username=benjamin`）同 Vivian（`username=vivian`）唔參與自動派單**，即使在職。排除係用戶名名單，唔係所有管理員（Eddie 仍然參與）。收藏（`active=0`）唔會被派單，亦登入唔到。優先名單係 `eddie`、`wing`、`jason`；其他在職同事排喺 Jason 後面。管理員可以人手改派，包括派畀 Tony、Benjamin 同 Vivian。`npm run seed` 會清走輪流游標，再由 Eddie 開始派示範留言。

如果資料庫係舊版本（未有 `whatsapp`、未有 `instagram`，或者未有 `intake_kind`／`origin_site`），啟動時會自動重建 `comments` 表。原有留言 id、內容同負責人都保留。舊嘅網站留言會標成 `site_comment`；舊嘅 WhatsApp 會標成 `whatsapp_click`，`origin_site` 留空（直接 WhatsApp）。

WhatsApp 入站會把客戶 `wa_id` 寫入 `comments.wa_from_phone`，收件線路寫入 `comments.wa_to_phone`。派單規則唔變。舊對話如果 `external_id` 係 `wa:{收件}:{寄件}`，啟動時會抄去呢兩欄。Meta `wamid` 而且未有呢兩欄嘅舊留言，要等客戶再傳一則（或本來已經用 `wa:{to}:{from}`）先至有號碼可發。

同事回覆喺 `comment_replies`（`staff_id`、`body`、`direction=outbound`、`delivery_status`、`delivery_error`）。`delivery_status` 可以係 `sent`。

## 公司 WhatsApp 出站（Cloud API）

同事喺收件箱回覆時，`createStaffReply` 會叫 `queueOutboundReply`。只有**公司總機** `85221740001`，而且留言有客戶號碼（`wa_from_phone`，或 `external_id` 係 `wa:85221740001:{客戶}`）先會發送：

`POST https://graph.facebook.com/v21.0/{WHATSAPP_PHONE_NUMBER_ID}/messages`

JSON 係文字訊息，`to` 係客戶 `wa_id`。成功標 `delivery_status=sent`。缺 token、冇客戶號碼、Graph 錯誤都標 `failed`，原因寫入 `delivery_error`，留言頁會顯示。唔會當成功。

同事個人線路、網站留言、Facebook、Instagram **唔**經呢條 Cloud API。Facebook／Instagram 用 Page token（見下一節）。官網仍然係 `stub`。唔會改 `whatsapp_lines` 嘅號碼，入站派單同 webhook 驗證都維持原樣。

Cloud API 嘅 `/{phone-number-id}/messages` 只可以公司總機 `85221740001` 做寄件人。同事個人號只係 `whatsapp_lines` 入面嘅派單綁定，冇註冊做呢個 WABA 嘅發送號碼，所以 token 改唔到 `from`。`message_echoes` 唔用。

## 同事用自己 WhatsApp 回覆客戶

客人用 WhatsApp 搵同事（打去同事個人號，或者打去公司總機之後派咗人）時，留言頁同留言箱有 **「用我嘅 WhatsApp 發送畀客戶」／「回覆客戶」**。

- 連結係 `https://api.whatsapp.com/send?phone=<客戶號碼>`，可選 `text=` 預填。
- 打開嘅係同事部手機或電腦**而家登入**嘅 WhatsApp。請登入已綁定嘅個人號，唔好登入公司總機。
- 公司總機嘅「發送回覆」仍然經 Cloud API，用 `85221740001`。
- 未綁定個人號仍然可以開連結，頁面會提示先綁定。
- 只係 WhatsApp 留言，而且要有客戶號碼。Facebook、Instagram、28car、官網唔顯示呢個按鈕。
- 睇唔到嘅留言（唔係負責人、又唔係管理員）唔會出連結，亦唔會出客戶號碼。

### Tony 點樣試

1. 用同事帳號登入 https://glorious-internal-inbox.onrender.com （個人號要管理員喺「WhatsApp 線路」綁定）。
2. 開一則 WhatsApp 留言：客戶打過嚟搵呢位同事，或者公司總機派咗畀佢。
3. 頁面要顯示客戶號碼，同你綁定嘅個人號碼。
4. 撳「用我嘅 WhatsApp 發送畀客戶」。應開 WhatsApp 同**客戶**對話，寄件人係你而家登入嘅號碼（應係個人號，唔係 `85221740001`）。
5. 可選填預填文字，仍然要喺 WhatsApp 按發送。
6. 同一則如果係公司總機，下面「發送回覆」仍然用公司號碼經 Cloud API 發出。
7. 用另一位唔負責呢則嘅同事開同一條網址，應係找不到。
8. Facebook／Instagram 留言唔應出現「用我嘅 WhatsApp 發送畀客戶」。
9. 客戶傳圖片或語音之後，留言頁可以直接睇圖同播放語音（要已設定 `WHATSAPP_ACCESS_TOKEN`，媒體先下載到）。
10. 喺同一頁可以「錄製語音」或上傳相片、影片。公司總機會用 `85221740001` 發出。同事個人號只會留喺收件箱播放，檔案要再喺自己 WhatsApp 傳送。

## 相片、影片同語音

客戶經 WhatsApp 傳圖片、影片或語音（包括 voice note）會入庫。Messenger／Instagram 私訊同 Facebook 留言如果 webhook 帶媒體連結，亦會下載。檔案放喺資料庫，唔係 Render 臨時硬碟。`GET /media/:id` 要登入，而且跟返留言可見範圍。

同事可以喺留言頁「傳送相片、影片或語音」上傳，或者撳「錄製語音」。播放器就喺對話入面。

| 渠道 | 出站 |
|------|------|
| 公司 WhatsApp 總機 | Cloud API 上傳再發送。瀏覽器 WebM 錄音會轉成 Ogg Opus。成功 `sent` |
| 同事個人 WhatsApp | 只儲存同播放，標 `stub`。請用上面深連結，喺自己 WhatsApp 傳送檔案 |
| Facebook／Instagram 私訊 | Graph `message_attachments` 再發私訊 |
| 公開留言、28car、官網 | 檔案留喺收件箱，標 `failed`，唔會假裝發咗去客戶 |

文字回覆、公司 Cloud API 文字、Facebook／Instagram 公開留言文字回覆都維持原樣。

本地：

```bash
npm run demo:inbox-media
```

公司總機嘅文字同媒體都用下面呢組環境變數。

### Tony 要喺 Render 設定

服務：`glorious-internal-inbox`。喺 Environment 加：

| 變數 | 必須？ | 值 |
|------|--------|----|
| `WHATSAPP_ACCESS_TOKEN` | 必須 | WhatsApp Cloud API token（`whatsapp_business_messaging`）。唔好用 `META_PAGE_ACCESS_TOKEN`。未設定就公司線回覆失敗 |
| `WHATSAPP_PHONE_NUMBER_ID` | 建議 | 公司總機 `85221740001` 嘅 phone number id。生產值 `241163761376752`。留空時代碼用同一個預設 |
| `WHATSAPP_GRAPH_VERSION` | 可選 | 預設 `v21.0` |

唔好把 token 寫入 git。改完要重新部署。

本地試出站（mock，唔會打去 Meta）：

```bash
npm run demo:whatsapp-outbound
```

## Facebook／Instagram 出站（Graph API）

同事喺收件箱回覆 `source=facebook` 或 `source=instagram`、而且 `intake_kind=site_comment` 時，`queueOutboundReply` 用 **Page access token** 打 Graph。由網站或 IG 撳入嚟嘅 WhatsApp（`source=whatsapp` 或 `intake_kind=whatsapp_click`）仍然只走 `WHATSAPP_ACCESS_TOKEN`。

| 入站 | Graph |
|------|--------|
| Facebook 公開留言（`meta_surface=comment`，或舊列嘅 comment id） | `POST https://graph.facebook.com/v21.0/{comment-id}/comments`，JSON `message` |
| Messenger 私訊（要有 PSID） | `POST https://graph.facebook.com/v21.0/{META_PAGE_ID}/messages`，`recipient.id` + `messaging_type=RESPONSE` |
| Instagram 公開留言 | `POST https://graph.facebook.com/v21.0/{comment-id}/replies`，JSON `message`（Page token，唔係 Instagram Login） |
| Instagram 私訊（要有 IGSID） | 同一個 Page `messages` 端點，`recipient.id` 係 IGSID，唔帶 `messaging_type` |

成功標 `delivery_status=sent`（畫面「已經 Facebook 發送」／「已經 Instagram 發送」）。缺 `META_PAGE_ACCESS_TOKEN`、私訊缺 `META_PAGE_ID` 或客戶 id、Graph 錯誤都標 `failed`，原因寫入 `delivery_error`。回覆路由唔會因為發送失敗而 500；留言仍然入庫，狀態由未處理改做處理中。

公開留言嘅 `external_id` 必須係 Graph comment id（數字，或 Facebook 嘅 `postId_commentId`）。Seed 示範 id（例如 `fb-3001`）唔會打去 Meta。私訊要有數字 PSID／IGSID（webhook 寫入 `meta_sender_id`；舊列 `msg:{id}:` 都可以還原）。

`META_GRAPH_VERSION` 可選，未設定用 `v21.0`。開機時 SQLite 同 Postgres 都會補上 `comments.meta_sender_id`／`meta_surface`（Postgres 用 `ADD COLUMN IF NOT EXISTS`，已經存在嘅 Render 庫唔使手動改表）。

### App Review／專頁指派（未做就 Graph 會失敗）

Token 填咗都唔等於客戶睇到。App 要有對應權限，而且發 token 嗰個人要喺專頁有任務。

| 回覆 | 需要 |
|------|------|
| Facebook 公開留言 | Page access token；`pages_manage_engagement`；專頁任務 `MODERATE` |
| Messenger | `pages_messaging`；專頁任務 `MESSAGING`；客戶 24 小時內有傳過訊（`RESPONSE`） |
| Instagram 公開留言 | 連住專頁嘅 Page token；`instagram_manage_comments`、`pages_read_engagement` |
| Instagram 私訊 | 同上 Page token；`instagram_manage_messages`；客戶要先傳過私訊 |

`META_IG_BUSINESS_ACCOUNT_ID` 係連住專頁嘅 IG 專業帳號。私訊 URL 用 `META_PAGE_ID`。呢個 IG id 用來認得帳號自己嘅 webhook，避免同事回覆之後再開一張工單。

### Render

服務：`glorious-internal-inbox`。喺 Environment 加（唔好寫入 git）：

| 變數 | 必須？ | 值 |
|------|--------|----|
| `META_PAGE_ACCESS_TOKEN` | 出站必須 | 專頁 Page access token。唔好當 WhatsApp token |
| `META_PAGE_ID` | 私訊必須 | Glorious Motors 專頁 id。公開留言回覆可以留空 |
| `META_IG_BUSINESS_ACCOUNT_ID` | 建議 | 連住專頁嘅 IG 專業帳號 id |
| `META_APP_SECRET` | 入站建議 | 驗證 `X-Hub-Signature-256` |
| `META_GRAPH_VERSION` | 可選 | 未設定用 `v21.0` |

本地 mock（唔會打去 Meta）：

```bash
npm run demo:meta-outbound
```

## 28car 車盤同留言板

十個車行帳號（只係登入名，密碼放 `TWENTYEIGHT_CAR_ACCOUNTS_JSON`）：

`gmld28013@hotmail.com`、`gmld28022@hotmail.com`、`gmld28035@hotmail.com`、`gmld28038@hotmail.com`、`gmld28040@hotmail.com`、`gmld28049@hotmail.com`、`gmld28050@hotmail.com`、`gmld28100@hotmail.com`、`gmld28112@hotmail.com`、`gmld28115@hotmail.com`

頁面：`/28car`。API：`GET /api/28car/listings`、`GET /api/28car/listings/:stockId`、`GET /api/28car/status`（要登入）。管理員可以 `POST /api/28car/sync` 同 `POST /api/28car/replies/flush`。

| 欄位 | 意思 |
|------|------|
| `stock_id` | 庫存編號，例如 `s2806213` |
| `vid` | `sell_dsp.php?h_vid=` 嘅內部編號。同庫存編號唔同。未同步到之前係空 |
| `public_url` | 有 vid 先至係 `https://www.28car.com/sell_dsp.php?h_vid={vid}&h_vw=y`。公開頁經常再用 frameset 去一個旋轉子網域 |
| `comment_count` | 賣車列表「留言」欄，只係數量 |
| 簡評 | 賣家廣告文字，唔係留言板 |
| 留言板 | `sell_dsp.php` 嘅 `#msgbox`。`msg_own` 係賣家帖 |

`gmld28013` 觀察到四個車盤（麥拿倫 720S、寶馬 I8、勞斯萊斯 PHANTOM EWB、豐田 ALPHARD）。`npm run seed`（本地示範）會寫低呢四個，**vid 留空**，因為讀頁先至知道。`npm start` 同 `npm run seed:staff` **唔會**寫呢啲觀察車盤。現場每個車盤只有一則賣家帖（WhatsApp `21740001` 附註），賣家帖放喺車盤頁，唔會變成客戶工單。Seed 另有一則示範買家留言（李先生問 720S），用來顯示「28car 留言板」標籤。`npm run clear:demo` 會刪呢則示範買家同 `sync_origin=observed` 嘅車盤。

買家一旦寫喺留言板，同步會寫入 `comments`，`source=28car`、`entry_path=28car_board`，畫面係「28car 留言板」，並且用同一套輪流次序派單（唔計未完成數）。

另一條路：客戶撳留言區入面嘅 WhatsApp 連結（`https://api.whatsapp.com/send?phone=85221740001`）入公司 WhatsApp。如果 Meta referral 係車輛頁（`sell_dsp.php`、`h_vid`、`h_vw`、`msgbox`），入庫係 `source=whatsapp`、`origin_site=28car`、`entry_path=28car_wa_link`，畫面係「28car 留言區 WhatsApp」。同一條 click-to-chat 官網同 Facebook 都用，所以**淨係**呢條 URL、又冇車輛頁 referral，唔會標成 28car。可以喺 webhook 明確傳 `entry_path: "28car_wa_link"`。

篩選：`GET /api/comments?entry=28car_board` 或 `entry=28car_wa_link`。留言箱有同一個下拉。

同事回覆 `source=28car` 而且對到車盤時，會排入 `car_reply_queue`。代發步驟（旗標同代理都齊先至發生）：

1. 用今次動作嘅代理登入該帳號。
2. 打開 `sell_dsp.php?h_vid={vid}&h_url_dsp_src=/mbr_sell.php&h_vw=1&h_f_bk=y`，讀 form1 嘅 `h_t`、`h_k`。
3. POST `/sell_dsp.php`：`h_mode=add`、`h_type=o`（車行身份）、`h_vid`、`h_url_dsp_src=/mbr_sell.php`、`h_msg`。頁面上的「回應此留言」只係 JavaScript 填字，唔係提交。
4. 唔使用 form2，亦唔會送 `h_mode=del`。

`h_t`／`h_k` 只活喺嗰一次請求，唔會寫入資料庫。遇到 `msg_busy.php`、403 或 Cloudflare 會停，唔會即刻再試。登入失敗會停晒成次運行，避免十個帳號連續打錯密碼。

### 出口 IP

`TWENTYEIGHT_CAR_SYNC_ENABLED` 同 `TWENTYEIGHT_CAR_REPLY_POST_ENABLED` 預設關閉。兩個都要同時有可輪換代理先至會出網絡：

- `TWENTYEIGHT_CAR_PROXY_URLS`：至少兩個 `http://` 或 `https://` 代理，每次動作用下一個，唔重複緊接上一次。
- 或者 `TWENTYEIGHT_CAR_PROXY_URL` 含 `{session}`。每次動作換 session，供應商要因此派一個新 IP。

一個固定代理、或者完全冇代理，系統會拒絕，**唔會**改為用 Render 機房 IP 直連。SOCKS 唔支援。代理網址唔會寫入 SQLite 或 log。

Render 免費服務係共用 IP，唔好在未接代理之前打開旗標。登入 POST 用 `mbr_login.php` 的 `h_username`、`h_password`、`h_mode=login`、`h_url_login_src`、`h_url_src`（登入頁冇 `h_t`／`h_k`）。未設定 `TWENTYEIGHT_CAR_LOGIN_FORM_JSON` 時用呢組。會員電話頁 `mbr_chg.php` 唔會讀、亦唔會改。

煙霧測試：`npm run demo:28car`

## 計劃中嘅真來源（除公司 WhatsApp 出站同 28car 車盤外）

`src/adapters/glorious-web.ts` 嘅 poll／出站仍然係 stub。Facebook／Instagram 入站經 `POST /api/webhooks/meta`（或 `site-comment`）；出站有 Page token 就打 Graph，見上面。官網 CMS 配線仍然要做。28car 即時同步同留言代發見上面，預設關閉。

`src/adapters/whatsapp.ts`：

- 公司號碼 click-to-chat（`COMPANY_WHATSAPP_URL`）
- 線路綁定同 `routeWhatsAppInbound` 派單
- `POST /api/webhooks/whatsapp` 收 Meta `messages` webhook（`display_phone_number`／客戶 `from`）同可選 stub JSON
- `queueOutboundReply`：公司總機有客戶號碼就打 Cloud API；同事個人線路標 `stub`

| 客戶所在 | 而家 |
|----------|------|
| 公司 WhatsApp，包括由網站或 IG 撳過嚟 | 有客戶號碼就 Cloud API 發送；成功 `sent`，失敗 `failed` |
| 同事個人 WhatsApp | 文字同媒體都唔經 Cloud API。頁面有深連結，用同事自己嘅 WhatsApp 發畀客戶。媒體留喺收件箱播放 |
| 28car 留言板 | 買家帖入庫為 `entry_path=28car_board`；代發要代理同旗標，否則排入隊列 |
| 28car 留言區 WhatsApp | 公司 WhatsApp 入站，`entry_path=28car_wa_link`，仍然走現有 Cloud API |
| 東榮官網留言 | 可用 `site-comment` webhook 入庫；出站 stub |
| Facebook 留言／Messenger | Meta webhook 入庫；有 Page token 就 Graph 發送，否則 `failed` |
| 東榮 IG 留言／私訊 | Meta webhook 入庫；有 Page token 就 Graph 發送，否則 `failed` |

click-to-chat 仍然可以人手開 WhatsApp 網頁。

## 公司電郵 gloriousinformation@gmail.com

現有 web 進程用 IMAP 讀呢個郵箱嘅 INBOX，用 SMTP 由同一個郵箱回信。唔會另開 Render 服務、worker、cron 或資料庫。信寫入現有 `comments`（`source=email`、`intake_kind=email`）。畫面來源係 **Email**，形式係 **email 留言**，並且寫明 **這是email的留言**。列表、留言頁、每一句對話同回覆框都會見到呢句，唔會扮成 WhatsApp、Facebook 或 Instagram。

同事仍然只撳現有 **回覆**／**發送回覆**。成功就由 `gloriousinformation@gmail.com` 寄畀客戶，`In-Reply-To` 對住客戶最新一封，主旨 `Re:` 原來主旨。未設定密碼或 OAuth 時，回覆標 `failed`，原因寫喺畫面上，唔會當已經寄出。

同一客戶電郵地址，未完成（未處理或處理中）只得一個收件箱 ID。狀態係已完成之後，下一封先至開新 ID。新對話用公司線輪流派單：**Eddie → Wing → Jason → 其餘在職同事（按 staff id）**。Tony、Benjamin、Vivian 唔參與。呢個次序冇改，只係電郵都用同一條。

列表「內容」仍然係客戶最新一句，唔係同事回覆。時間顯示香港時間。電郵入面嘅相片同 MP4 影片會用現有媒體播放；其他附件（例如 PDF）只會喺正文註明未收入，唔會另做一套媒體庫。

`GET /api/health` 嘅 `email.enabled` 係 `true` 先代表伺服器認到憑證。唔會返回密碼或 token。

煙霧測試：`npm run demo:email`

### 邊啲信會入庫

程式只收 **寄入呢個郵箱**、而且符合下面其中一條嘅信。

**公司主旨。** 主旨有法定英文名就入，正文唔使係車。認呢兩句，大小寫、多餘空白、逗號、句號、連字號都當同一句：

- `Glorious Motors Ltd`
- `Glorious Motors Limited`

例子：`Re: GLORIOUS MOTORS, LTD.`、`Glorious-Motors Limited`。主旨淨係寫 Glorious Motors、或者個名只出現喺正文，都唔算呢條。

**車務。** 主旨冇公司名時，主旨或者正文新寫嘅部分（唔計 `>` 引用）要**明顯係車**，例如：

- 買車、賣車、查詢、報價、現貨、車盤、試車、以舊換新、供車、車牌
- 車型或品牌（Alphard、豐田、寶馬、平治等，完整名單喺 `src/services/email-filter.ts`）
- 28car 庫存編號（例如 `s2806213`）或 28car 車盤連結
- 「想買一部車」「I want to buy a car」呢類同時有車同查詢意思嘅句子

兩樣都唔係就**唔入**。下面呢啲只擋「唔係公司主旨」嘅信；主旨已經係 Glorious Motors Ltd／Limited 就仍然入庫。就算提到「車」或車型都唔入嘅情況：

- 電子報、`List-Unsubscribe`、大量發送（bulk）、`noreply`／`newsletter` 呢類寄件人
- Facebook、Instagram、Meta、LinkedIn 等社交通知
- 驗證碼、一次性密碼、重設密碼
- 銀行通知
- 唔係查車嘅收據、發票、訂單確認
- 廣告（有退訂／限時優惠，又冇客戶自己問）
- 內部 IT、中獎、停車場、車票、車厘子呢類唔係車行往來嘅「車」

已經有未完成電郵對話嘅同一地址，之後一句唔再提到車嘅短覆（例如「星期六 OK」）會附加到同一個 ID。驗證碼、廣告、銀行、電子報呢類硬性拒絕唔會附加。對話已完成之後，唔係車嘅信唔會再開新 ID。

### 幾耐掃一次，瞓著咗點補

預設每 **2 分鐘** 掃一次，每次最多 50 封。游標（`email_sync_state` 嘅 UID 同 UIDVALIDITY）寫喺現有 Postgres。

Render 免費 Web Service 大約 15 分鐘冇人開會休眠，休眠期間**唔會**輪詢。Gmail 仍然留住封信。下次有請求喚醒進程，啟動大約 5 秒後先掃，再按間隔掃。喚醒或重啟都由上次成功嘅 UID 繼續，所以休眠期間到埗嘅信會補入，唔使重寄。

第一次成功掃描，或者 Gmail 重建過郵箱（UIDVALIDITY 變咗），只會睇返最近 `GLORIOUS_EMAIL_LOOKBACK_DAYS` 日（預設 14，最大 90）。比呢個窗口更舊、又未入過庫嘅信唔會自動入。已經入庫嘅 Message-ID 唔會開第二張單。

### Tony 合併之後要做（呢個 PR 唔會部署）

仍然用現有 web service `glorious-internal-inbox`。唔好新開服務。

**應用程式密碼（建議）**

1. 用 `gloriousinformation@gmail.com` 登入 Google 帳戶，開啟兩步驗證。
2. 打開 [應用程式密碼](https://myaccount.google.com/apppasswords)，選郵件，產生一組 16 位密碼。
3. Gmail → 設定 → 轉寄和 POP/IMAP → **啟用 IMAP**。
4. 喺 Render 嗰個 web service 嘅 Environment 加下面變數。唔好寫入 git，唔好貼去 PR。
5. 改完環境變數後重新部署**現有** web service。`GET /api/health` 睇 `email.enabled` 係 `true`。

| 變數 | 必須？ | 值 |
|------|--------|----|
| `GLORIOUS_EMAIL_ADDRESS` | 建議寫明 | `gloriousinformation@gmail.com` |
| `GLORIOUS_EMAIL_APP_PASSWORD` | 用密碼就必須 | Google 應用程式密碼（可以有空格，程式會去掉） |
| `GLORIOUS_EMAIL_POLL_MS` | 可選 | `120000` |
| `GLORIOUS_EMAIL_LOOKBACK_DAYS` | 可選 | `14` |

**OAuth（冇應用程式密碼先用）**

1. Google Cloud 開一個專案，啟用 Gmail API。
2. OAuth 同意畫面把 `gloriousinformation@gmail.com` 加做測試用戶。
3. 建立桌面應用程式用戶端，攞 client id 同 client secret。
4. 用 [OAuth Playground](https://developers.google.com/oauthplayground/) 或你自己嘅一次過授權，scope 選 `https://mail.google.com/`，換一條 refresh token。
5. 設 `GLORIOUS_EMAIL_OAUTH_CLIENT_ID`、`GLORIOUS_EMAIL_OAUTH_CLIENT_SECRET`、`GLORIOUS_EMAIL_OAUTH_REFRESH_TOKEN`。三項都要齊。如果同時有應用程式密碼，程式用密碼。

IMAP／SMTP 主機留空就用 Gmail。唔好把密碼、client secret 或 refresh token 提交。

## 授權

UNLICENSED · 東榮汽車內部使用
