# Steam Atlas · 蒸汽图鉴

> **本项目由 AI 编写。**
> 代码、页面、样式与文档均由 AI（DeepSeek+gpt-6-luna）根据需求生成并迭代完成，人工仅提出需求与反馈。使用或二次开发前请自行 Review 代码。

Steam 数据查询工具，包含：

- 游戏资料：简介、截图、宣传片、成就、DLC、发行版本、支持语言、配置要求、年龄分级与版权信息。
- 全球 16 区价格：本地定价、汇率估算、折扣与非本地货币提示。
- 玩家档案：SteamID64、个性域名、等级、徽章、游戏库、封禁与最近游玩。
- 隐私逐项标注：公开、仅好友可见、私密分别显示，不把受限数据伪装成无数据。
- 玩家称号：服务端可配置 Owner、Admin 等称号，显示在 Steam 名称后。

## 两种运行方式

### A. 无 Node.js：GitHub Pages 静态预览

访问 <https://project-steamweb.github.io/> 即可预览 UI。该版本不需要安装 Node.js，也不会请求 Steam API，使用内置演示数据展示游戏、区服价格、个人资料和隐私标记。

静态预览可以：

- 切换「游戏资料 / 全球区价 / 玩家档案」三个视图；
- 选择演示区服，查看货币与价格变化；
- 查看成就、配置要求、DLC、玩家称号和私密字段标记；
- 在 GitHub Pages、任意静态空间或本地直接打开 `index.html`。

静态预览不能：

- 实时查询 Steam 游戏或玩家；
- 读取最新价格、游戏库和封禁数据；
- 使用服务端加密的 Steam Web API Key。

### B. 完整版：Node.js 服务

完整功能需要 **Node.js 20+**。Steam 商店和社区接口需要服务端代理，Steam Web API Key 也只能放在服务端。

```bash
node server.mjs
```

然后打开 <http://127.0.0.1:8787>。也可以运行 Windows 启动脚本：

```text
启动网站.bat
```

## 部署说明

GitHub Pages 只能运行静态文件，不能运行 `server.mjs`。如需实时功能，请将 Node 服务部署到 Render、Railway、Fly.io 或自己的 VPS，再把前端 API 地址改为后端地址。

## 安全与隐私

- Steam API Key 通过 AES-256-GCM 加密存储在 `.steam-key.enc`，解密密钥在 `.steam-key.secret`；两者均已加入 `.gitignore`，不会进入仓库。
- 本项目不是 Valve / Steam 官方产品，与 Valve 无隶属关系。
- 私密或仅好友可见的数据由 Steam 隐私设置决定，本站不会绕过隐私设置。
- 区服人民币金额为公开汇率估算，实际结算以 Steam 商店为准。

## 项目结构

```text
steam-web/
├─ index.html              # 无 Node.js 静态预览 / GitHub Pages 首页
├─ server.mjs              # 零依赖 Node HTTP 服务 + Steam API 代理
├─ set-key.mjs             # 加密写入 / 更换 Steam Web API Key
├─ public/
│  ├─ index.html           # 完整版应用页面
│  ├─ app.js               # 完整版 SPA、搜索、比价、玩家档案
│  ├─ styles.css           # 完整版设计系统与响应式布局
│  └─ favicon.svg
├─ package.json
├─ .env.example
└─ README.md
```

## 接口来源

| 本站接口 | 上游 |
| --- | --- |
| `/api/search` | Steam Store `storesearch` / `appdetails` |
| `/api/featured` | Steam Store `featuredcategories` |
| `/api/app/:id` | Steam Store `appdetails` |
| `/api/prices/:id` | 对 16 个 `cc` 分别请求 `appdetails` |
| `/api/profile` | Steam Web API 或 `steamcommunity.com/.../?xml=1` |
| 汇率估算 | `open.er-api.com`，失败时回退 `frankfurter.app` |

## 许可证

本项目采用 **GNU General Public License v3.0（GPL-3.0-or-later）** 开源，详见 [LICENSE](LICENSE)。

## 版权信息

版权所有 © 2026 wangzic

本项目由 AI 编写并在 GPL-3.0-or-later 协议下开源。你可以依据 GPL 协议自由使用、复制、修改和分发本项目，但衍生作品须继续遵守 GPL 协议并保留相应版权与许可证声明。
