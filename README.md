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
- 同事名單頁
- JSON API（`/api/...`）方便日後接流動 App 或自動化

### 主要網址

- 網頁：`http://localhost:3001/`
- 健康檢查：`GET /api/health`
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

## 資料庫

SQLite（`better-sqlite3`），檔案喺 `data/inbox.db`（已加入 `.gitignore`）。

派單規則（seed／未指派留言）：**未完成（open + in_progress）最少嘅同事優先，同數則 staff id 較細者**。

## 計劃中嘅真來源

`src/adapters/twentyeightcar.ts`、`glorious-web.ts`、`facebook.ts` 暫時只係 stub，之後再接登入／API／webhook。

## 授權

UNLICENSED · 東榮汽車內部使用
