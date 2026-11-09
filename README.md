# Steam Atlas · 蒸汽图鉴

> **本项目由 AI 编写。**
> 代码、页面、样式与文档均由 AI（DeepSeek 驱动的编码助手）根据需求生成并迭代完成，人工仅提出需求与反馈。请在阅读、使用或二次开发时自行 Review 代码，尤其在部署到公网前确认安全性与合规性。

一个可直接调取 Steam 公开数据的中文网站：

- **游戏资料**：搜索游戏名 / App ID，查看商店简介、截图、宣传片、类型、发行商、发行日期、Metacritic、评价数、成就、DLC、发行版本、支持语言、配置要求、年龄分级与版权信息。
- **全球 16 区价格**：一次读取中国、中国香港、中国台湾、美国、日本、韩国、新加坡、英国、欧元区、加拿大、澳大利亚、巴西、墨西哥、土耳其、阿根廷、俄罗斯的本地定价，按公开汇率估算人民币并横向排序。
- **玩家个人资料**：支持 SteamID64、个性域名（自定义 URL）、SteamID3 和完整主页链接（可省略 `https://`）。无 API Key 时读取公开档案；配置 Steam Web API Key 后解锁 Steam 等级与 XP、徽章数量、游戏库数量与总时长、游戏时长 Top 6、最近两周游戏、VAC / 社区 / 交易封禁明细、当前游戏、最近在线与地区等详细字段。
- **隐私逐项标注**：个人资料页会单独列出「个人资料页 / 个人资料详情 / 游戏库 / 游戏时长 / 真实姓名 / 地区 / 最近在线 / 公开群组」等项目的可见性，私密或仅好友可见的项目显示为受限并说明原因，不会伪装成「无数据」。
- **区服货币提示**：若某区 Steam 商店改用非本地货币计价（如阿根廷、土耳其以美元计价），价格表会标注「商店以 USD 计价」，避免误以为选错了区服。
- 中文界面、深色响应式设计，无需数据库，无需登录 Steam 账号。

> Steam 官方接口不支持按“玩家昵称”搜索，请使用 17 位 SteamID64、个性域名或主页链接。

## 运行

需要 **Node.js 20+**（已在 Node.js 24 测试）。项目没有第三方依赖。

```bash
cd D:\Desktop\steam-web
node server.mjs
```

打开 <http://127.0.0.1:8787>。

也可以使用：

```bash
npm start
```

或开发模式（文件变更自动重启）：

```bash
npm run dev
```

## Steam Web API Key（服务端内置，已加密）

项目已经内置一把 Steam Web API Key，玩家档案默认走官方接口，无需在页面上填写任何 Key。页面不再提供自定义 Key 入口。

- Key 使用 **AES-256-GCM** 加密后保存在 `.steam-key.enc`，解密密钥单独存放在 `.steam-key.secret`。(注意:开源版本不带API请自行用AES-256-GCM加密后存放在steam-key.enc，解密密钥放在steam-key.secret)
- 两个文件都不会被 Git 跟踪（见 `.gitignore`），也不会被任何接口返回或写入日志；浏览器只收到 `hasServerKey: true/false`。
- 更换 Key：`node set-key.mjs 新的32位Key`，然后重启服务。
- 彻底撤销：删除 `.steam-key.enc` 与 `.steam-key.secret`，重启后自动退回公开档案模式。

> 说明：本机服务最终必须把 Key 解密后发送给 Steam，因此对拥有本机文件读写权限的人无法做到绝对保密；当前方案的目标是避免明文出现在源码、网页、日志和仓库中。

## 可选环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址；局域网访问可设为 `0.0.0.0` |
| `STEAM_API_KEY` | 空 | 临时覆盖内置加密 Key，仅调试用 |

`.env` 会在启动时自动读取（无需额外包）。

## 数据来源与接口

所有 Steam 请求都由本机 Node 服务代理，避免浏览器 CORS 与 Key 暴露：

| 本站接口 | 上游 |
| --- | --- |
| `/api/search` | Steam Store `storesearch` / `appdetails` |
| `/api/featured` | Steam Store `featuredcategories` |
| `/api/app/:id` | Steam Store `appdetails` |
| `/api/prices/:id` | 对 16 个 `cc` 分别请求 `appdetails` |
| `/api/profile` | Steam Web API（有 Key）或 `steamcommunity.com/.../?xml=1`（公开档案） |
| 汇率估算 | `open.er-api.com`（失败时回退 `frankfurter.app`） |

内置缓存：游戏详情 10 分钟、排行榜 8 分钟、区价 10 分钟、汇率 12 小时；并对并发请求做合并，减少对 Steam 的重复请求。

## 项目结构

```
steam-web/
├─ server.mjs              # 零依赖 Node HTTP 服务 + Steam API 代理 + 缓存
├─ set-key.mjs             # 加密写入 / 更换 Steam Web API Key
├─ .steam-key.enc          # 加密后的 Key（不入库）
├─ .steam-key.secret       # 解密密钥（不入库，勿外传）
├─ index.html              # 仓库首页 / GitHub Pages 落地页（仅说明，不含功能）
├─ public/
│  ├─ index.html           # 页面骨架、SVG 图标
│  ├─ styles.css           # 设计系统与响应式布局
│  ├─ app.js               # 哈希路由 SPA、搜索、比价、玩家档案
│  └─ favicon.svg
├─ package.json
├─ .env.example
└─ README.md
```

## 部署说明（重要）

这个项目**不是纯静态网站**，`server.mjs` 必须运行在 Node.js 环境中：

- Steam 商店与社区接口不返回 CORS 头，浏览器无法直接请求，必须由本机 / 服务器代理；
- Steam Web API Key 只能在服务端使用，不能放进前端。

因此 **GitHub Pages 只能托管 `public/` 静态文件，无法运行后端**。仓库名虽然叫 `project-steamweb.github.io`，但直接用它做 Pages 时页面会加载出来、所有 API 请求却会 404。

要真正上线，请选择其一：

| 方案 | 说明 |
| --- | --- |
| 本地运行 | `node server.mjs`，仅自己使用（最简单） |
| Node 托管平台 | Render / Railway / Fly.io / 自有 VPS 运行 `node server.mjs`，绑定域名 |
| 前后端分离 | 后端部署到上述平台，前端静态托管到 Pages，并把 `api()` 的请求前缀改成后端地址 |

## 说明与限制

- 本项目不是 Valve / Steam 官方产品，与 Valve 无隶属关系。
- 区服价格来自 Steam 商店公开接口，可能因锁区、发行版本差异、促销结束而变动；人民币金额是汇率估算，**实际结算以 Steam 商店为准**。
- 私密 / 仅好友可见的玩家档案无法通过公开接口读取；用户隐私设置优先。
- 最近游戏、游戏库与封禁明细依赖 Steam Web API Key（已内置）；若玩家把“游戏详情”设为私密，Steam 会返回空库，页面会明确提示数据受限。
- 请合理控制请求频率。项目自带简单限流与缓存，但请勿用于大规模抓取。
- 仅供学习与个人查询使用；请遵守 Steam 服务条款及当地法律法规。
