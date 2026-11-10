# Steam Atlas · 蒸汽图鉴

> **本项目由 AI 编写。**
> 代码、页面、样式与文档均由 AI（DeepSeek+gpt-6-luna+MiniMaxM3）根据需求生成并迭代完成，人工仅提出需求与反馈。使用或二次开发前请自行 Review 代码。

Steam 数据查询工具，包含：

- 游戏资料：简介、截图、宣传片、成就、DLC、发行版本、支持语言、配置要求、年龄分级与版权信息。
- 全球 16 区价格：本地定价、汇率估算、折扣与非本地货币提示。
- 玩家档案：SteamID64、个性域名、等级、徽章、游戏库、封禁与最近游玩。
- 隐私逐项标注：公开、仅好友可见、私密分别显示，不把受限数据伪装成无数据。
- 玩家称号：服务端可配置 Owner、Admin 等称号，显示在 Steam 名称后。
- **Steam 登录**：通过 Steam 官方 OpenID 2.0 登录，登录后侧边栏显示头像与昵称，一键打开自己的档案。
- **一键启动游戏**：游戏页与卡片上直接用本机 Steam 客户端启动游戏。
- **浏览器扩展**：在浏览器侧边栏里搜索游戏、读游戏库，并直接启动游戏。

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
- 使用服务端加密的 Steam Web API Key；
- Steam 登录（登录依赖服务端 OpenID 回调与 Cookie 会话）。

Steam 登录与浏览器扩展属于完整版功能。

### B. 完整版：Node.js 服务

完整功能需要 **Node.js 20+**。Steam 商店和社区接口需要服务端代理，Steam Web API Key 也只能放在服务端。

```bash
node server.mjs
```

然后打开 <http://127.0.0.1:8787>。也可以运行 Windows 启动脚本：

```text
启动网站.bat
```

## Steam 登录（OpenID 2.0）

Steam 没有第三方 OAuth，官方登录方式是 **Steam OpenID 2.0**。本站按该协议实现：

1. 点击侧边栏「Steam 登录」，服务端生成一次性 `state` 并 302 跳转到 `steamcommunity.com/openid/login`；
2. 用户在 Steam 官方页面登录并授权；
3. Steam 带签名回跳 `/api/auth/callback`；
4. 服务端校验 `openid.mode`、`openid.ns`、`openid.return_to`、`openid.claimed_id`，并用 **HMAC-SHA1 重算签名**做恒定时间比对；
5. 校验通过后用 Steam Web API 拉取账号资料，写入服务端会话并下发 `HttpOnly` + `SameSite=Lax` Cookie；
6. 前端显示头像与昵称，「退出登录」清除会话。

安全要点：

- 签名错误或 `return_to` 不匹配一律拒绝登录；
- `state` 一次性、10 分钟过期，防止 CSRF 与重放；
- 会话只保存在服务端内存中，进程重启即失效，Cookie 只含随机令牌；
- 校验 OpenID 签名需要服务端 Web API Key；未配置 Key 时登录会明确提示不可用。

兼容性处理（Steam 与 OpenID 2.0 规范在细节上不一致，这里全部兼容）：

- **签名编码**：分别尝试 `encodeURIComponent`、`/` 不转义、空格转 `+`、完全不转义四种写法；
- **取值来源**：同时用解码后的参数值与原始查询串中的值参与验签；
- **字段顺序**：既按 `openid.signed` 给出的顺序，也按字典序拼接；
- **结尾 `&`**：两种形式都尝试。

以上候选全部用同一把 API Key 做 HMAC-SHA1 校验，能匹配上的才算通过，因此兼容性处理不会削弱签名强度。

另外，Steam 回跳时可能用 `?` 而不是 `&` 拼接参数，导致 `state` 被污染；服务端会同时在回调查询串和 `openid.return_to` 中查找并还原真实 `state`。

接口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/auth/login` | 发起登录，跳转 Steam OpenID |
| `GET /api/auth/callback` | 校验签名并建立会话 |
| `GET /api/auth/session` | 读取当前登录状态 |
| `POST /api/auth/logout` | 退出登录 |
| `GET /api/auth/me` | 读取登录账号的完整档案 |

## 管理后台

访问 <http://127.0.0.1:8787/#/admin>（侧边栏也有入口）。

默认账号与密码：

```text
账号：steamweb
密码：qwerQWER1
```

建议上线前用环境变量覆盖：

```bash
ADMIN_USERNAME=你的账号
ADMIN_PASSWORD=你的强密码
```

设置 `ADMIN_PASSWORD` 后，服务启动会用新密码重新生成凭据文件；否则使用 `data/admin.json` 中已保存的哈希。

后台功能：

| 区域 | 内容 |
| --- | --- |
| 运行状态 | 版本、运行时长、是否配置 API Key、区服数、缓存条目、登录会话数、Node 版本 |
| 玩家称号 | 在线增删改称号（SteamID64、名称、颜色、优先级），保存后立即生效并持久化到 `data/titles.json` |

安全设计：

- 密码使用 **PBKDF2-SHA512（12 万次迭代 + 随机盐）** 哈希保存，明文不落盘；
- 校验使用恒定时间比较，登录失败 10 次锁定 10 分钟；
- 管理会话与 Steam 登录会话分离，Cookie 为 `HttpOnly` + `SameSite=Strict`，仅存服务端内存；
- `data/admin.json` 已加入 `.gitignore`，不会进入仓库。

| 接口 | 说明 |
| --- | --- |
| `GET /api/admin/session` | 读取后台登录状态 |
| `POST /api/admin/login` | 账号密码登录 |
| `POST /api/admin/logout` | 退出后台 |
| `GET /api/admin/stats` | 服务运行状态 |
| `GET /api/admin/titles` | 读取称号列表 |
| `PUT /api/admin/titles` | 保存称号列表 |

## 启动本机 Steam 客户端

网站使用 Steam 官方协议链接，可在已安装 Steam 的机器上直接拉起客户端：

```text
steam://run/<appid>      启动游戏
steam://store/<appid>    在客户端中打开商店页
```

入口位置：游戏详情页顶部的「启动游戏」按钮、右侧精选卡片的「用 Steam 客户端启动」、以及所有游戏卡片悬停时右上角的手柄图标。未安装 Steam 客户端时浏览器会提示「未知协议」，此时改用商店网页链接即可。

## 浏览器扩展

`extension/` 目录下是一个 Manifest V3 扩展，提供：

- **搜索**：调用 Steam 商店公开接口搜索游戏，结果可一键启动 / 打开客户端商店页 / 打开网页商店；
- **我的库**：读取游戏库数量、总时长与最近在玩，支持 SteamID64 与个性域名；
- **账号**：保存自己的 Steam Web API Key（仅写入本机 `chrome.storage.local`）；
- 自动识别当前浏览器已登录的 Steam 账号。

安装方式见 [extension/README.md](extension/README.md)：在 `chrome://extensions` 或 `edge://extensions` 打开开发者模式，选择「加载已解压的扩展程序」并指向 `extension/` 目录。

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
├─ data/
│  ├─ titles.json          # 玩家称号配置（管理后台写入，已入库）
│  └─ admin.json          # 管理员凭据哈希（不入库）
├─ extension/              # 浏览器扩展（Manifest V3）
│  ├─ manifest.json        # 扩展清单
│  ├─ background.js        # 后台服务：代发 Steam 请求
│  ├─ content.js           # 侦测浏览器已登录的 Steam 账号
│  ├─ panel.html/.css/.js  # 面板界面（弹出窗口 / 侧边栏）
│  └─ README.md            # 安装与使用说明
├─ test/
│  └─ openid.test.mjs      # Steam OpenID 登录握手的端到端测试
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
| `/api/auth/*` | Steam OpenID 2.0 + Steam Web API 校验 |
| 汇率估算 | `open.er-api.com`，失败时回退 `frankfurter.app` |

## 测试

服务启动后可运行 OpenID 登录握手的端到端测试（会本地解密 Key，仅用于签名校验，不会打印）：

```bash
node test/openid.test.mjs
```

## 许可证

本项目采用 **GNU General Public License v3.0（GPL-3.0-or-later）** 开源，详见 [LICENSE](LICENSE)。

## 版权信息

版权所有 © 2026 wangzic

本项目由 AI 编写并在 GPL-3.0-or-later 协议下开源。你可以依据 GPL 协议自由使用、复制、修改和分发本项目，但衍生作品须继续遵守 GPL 协议并保留相应版权与许可证声明。
