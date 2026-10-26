# 東榮汽車 · 內部留言系統（glorious-internal-inbox）

公司**內部專用**網頁，畀同事登入後處理客戶留言／查詢：

| 來源 | 網址 | 程式碼識別 |
|------|------|------------|
| 28car | https://www.28car.com | `28car` |
| 東榮官網 | https://glorious.hk/cn2/ | `glorious_web` |
| Facebook | https://www.facebook.com/GloriousMotors | `facebook` |
| WhatsApp | 公司總機 `85221740001` 同已綁定嘅同事個人號 | `whatsapp` |

而家用**示範資料**；真實抓取適配器喺 `src/adapters/`（stub，標咗 TODO）。

> ⚠️ 呢個系統只供東榮內部同事使用，唔應公開喺互聯網冇保護咁部署。

## 需求

- Node.js 20+
- npm

## 快速開始

```bash
cp .env.example .env   # 改 SESSION_SECRET，以及 WEBHOOK_VERIFY_TOKEN（要用 webhook 先至需要）
npm install
npm run seed           # 寫入 11 位同事 + 示範留言 + 公司 WhatsApp 總機
npm start              # http://localhost:3001
```

開發模式（自動重載）：

```bash
npm run dev
```

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
- 留言列表：按來源、狀態、「只睇我嘅」篩選
- 留言詳情：改狀態（未處理／處理中／已完成）、改派同事
- 留言列表／詳情：公司 WhatsApp click-to-chat；負責人若已綁定個人號，會另外顯示同事 WhatsApp
- 同事名單頁（顯示已綁定嘅個人 WhatsApp）
- 管理員：WhatsApp 線路頁（綁定／停用同事個人號）
- JSON API（`/api/...`）方便日後接流動 App 或自動化

### 主要網址

- 網頁：`http://localhost:3001/`
- 健康檢查：`GET /api/health`（包含 `company_whatsapp_url`）
- 公開設定：`GET /api/config` → `{ "company_whatsapp_url": "..." }`
- 登入 API：`POST /api/auth/login` `{ "username", "password" }`
- 留言：`GET /api/comments?source=&status=&mine=1`
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

## 公司 WhatsApp click-to-chat

留言列表同留言詳情有 **WhatsApp** 按鈕，開新分頁去公司 click-to-chat。有資料時會用 `text` 預填一段短訊，包含來源、車輛編號同留言摘要。

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
  "external_id": "demo-1"
}
```

`to`／`from` 可以帶 `+`、空格或橫線，程式會收成數字。

亦接受簡化版 Meta Cloud API：`entry[].changes[].value.metadata.display_phone_number` 加 `messages[]`（`text.body`）。只有 `statuses`、冇文字訊息時會回 `{ "ok": true, "ignored": true }`，方便日後 Meta 驗證。

Meta 訂閱驗證（稍後先用）：

`GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WEBHOOK_VERIFY_TOKEN>&hub.challenge=<challenge>`

Token 唔啱回 401／403。環境變數未設定回 503。**唔好將真實 token 寫入 git。**

## 資料庫

SQLite（`better-sqlite3`），檔案喺 `data/inbox.db`（已加入 `.gitignore`）。

派單規則（seed／未指派留言／公司 WhatsApp 總機）：**未完成（open + in_progress）最少嘅同事優先，同數則 staff id 較細者**。

如果資料庫係舊版本（`comments.source` 未有 `whatsapp`），啟動時會自動重建 `comments` 表以加上呢個來源，原有留言會保留。

## 計劃中嘅真來源

`src/adapters/twentyeightcar.ts`、`glorious-web.ts`、`facebook.ts` 暫時只係 stub，之後再接登入／API／webhook。

`src/adapters/whatsapp.ts` 同樣**未**連接 Meta／Glorious WhatsApp。而家只係：

- 公司號碼 click-to-chat（`COMPANY_WHATSAPP_URL`）
- 線路綁定同 `routeWhatsAppInbound` 派單
- `POST /api/webhooks/whatsapp` stub，等之後先至接真實 payload

## 授權

UNLICENSED · 東榮汽車內部使用
