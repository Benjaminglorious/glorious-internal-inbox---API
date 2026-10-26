# 東榮汽車 · 內部留言系統（glorious-internal-inbox）

公司**內部專用**網頁，畀同事登入後處理來自三個來源嘅客戶留言／查詢：

| 來源 | 網址 | 程式碼識別 |
|------|------|------------|
| 28car | https://www.28car.com | `28car` |
| 東榮官網 | https://glorious.hk/cn2/ | `glorious_web` |
| Facebook | https://www.facebook.com/GloriousMotors | `facebook` |

而家用**示範資料**；真實抓取適配器喺 `src/adapters/`（stub，標咗 TODO）。

> ⚠️ 呢個系統只供東榮內部同事使用，唔應公開喺互聯網冇保護咁部署。

## 需求

- Node.js 20+
- npm

## 快速開始

```bash
cp .env.example .env   # 改 SESSION_SECRET
npm install
npm run seed           # 寫入 11 位同事 + 示範留言
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
- 留言列表／詳情：WhatsApp 按鈕開公司 click-to-chat（尚未同步對話）
- 同事名單頁
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

## 環境變數

見 `.env.example`：

- `PORT`（預設 `3001`）
- `SESSION_SECRET`（必須改成夠長嘅隨機字串）
- `DATABASE_PATH`（可選，預設 `./data/inbox.db`）
- `COMPANY_WHATSAPP_URL`（公司 WhatsApp click-to-chat。未設定時預設 `https://api.whatsapp.com/send?phone=85221740001`，即 28car／官網／Facebook 用緊嘅號碼 `85221740001`）

## 公司 WhatsApp

留言列表同留言詳情有 **WhatsApp** 按鈕，開新分頁去公司 click-to-chat。有資料時會用 `text` 預填一段短訊，包含來源、車輛編號同留言摘要。

`GET /api/config`（同 `GET /api/health`）回傳 `company_whatsapp_url`，前端唔使自己硬編碼呢條連結。

**尚未連接 WhatsApp 聊天同步。** `src/adapters/whatsapp.ts` 只係 stub：日後先經 WhatsApp Business API 拉取入站對話。而家唔會呼叫任何 WhatsApp API，留言箱亦唔會出現 WhatsApp 訊息。

## 資料庫

SQLite（`better-sqlite3`），檔案喺 `data/inbox.db`（已加入 `.gitignore`）。

派單規則（seed／未指派留言）：**未完成（open + in_progress）最少嘅同事優先，同數則 staff id 較細者**。

## 計劃中嘅真來源

`src/adapters/twentyeightcar.ts`、`glorious-web.ts`、`facebook.ts` 暫時只係 stub，之後再接登入／API／webhook。

`src/adapters/whatsapp.ts` 同樣係 stub：公司號碼而家只係 click-to-chat，**未**經 WhatsApp Business API 同步入站對話。

## 授權

UNLICENSED · 東榮汽車內部使用
