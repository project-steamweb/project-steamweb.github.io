# Steam Atlas · 蒸汽图鉴

> **本项目由 AI 编写。**
> 代码、页面、样式与文档均由 AI（DeepSeek+gpt-6-luna+MiniMaxM3）根据需求生成并迭代完成，人工仅提出需求与反馈。使用或二次开发前请自行 Review 代码。

Steam 数据查询工具，包含：

- 游戏资料：简介、截图、宣传片、成就、**可下载内容（DLC 列表）**、**DLC 可反查本体游戏**、发行版本、支持语言、配置要求、年龄分级与版权信息。
- **更多社交媒体与相关链接**：自动抓取商店页面里开发者填写的 YouTube / Discord / X / Twitch / TikTok / Instagram / Facebook / Bluesky / Reddit / 微博 / 哔哩哔哩 等账号，并附上官网、支持页、Steam 社区、讨论区、创意工坊、更新记录与 **SteamDB** 入口。
- 全球 16 区价格：本地定价、汇率估算、折扣与非本地货币提示。
- **搜索能找到已下架游戏**：商店搜索只收录仍在售的游戏，本站自己扫描 Steam 的 App ID 空间建立名称索引，下架但资料仍在的游戏照样能搜到（结果标「已下架」）。
- 玩家档案：SteamID64、个性域名、等级、徽章、游戏库、封禁与最近游玩。
- **封禁记录**：VAC 封禁、**游戏封禁（Game Ban）**、社区封禁、交易封禁与距上次封禁天数，来自 Steam 官方 `ISteamUser/GetPlayerBans`。
- **Valve 员工识别**：识别出 Valve 官方员工后，在名称后加上「Valve员工」称号，并在资料页顶部显示黄色防诈骗提醒。
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

> **重要：Steam 登录要求「访问本站的域名」与「Steam Web API Key 注册的域名」一致。**
>
> Steam 用**该域名注册的 API Key** 对登录回跳做 HMAC-SHA1 签名。如果用 `http://127.0.0.1:8787` 这类没有注册过 Key 的地址发起登录，Steam 就没有可用的签名密钥，回跳一定无法通过校验。
>
> 解决办法：把本站部署到一个域名，并在 <https://steamcommunity.com/dev/apikey> 把该 Key 的 **Website / Domain** 设为这个域名，然后**用这个域名访问本站**再登录。
>
> 随时可以查看当前生效的回调地址：
>
> ```bash
> curl http://127.0.0.1:8787/api/auth/debug
> ```
>
> 反向代理部署时，服务端会读取 `x-forwarded-host` / `x-forwarded-proto` 推断对外地址，也可以直接指定：
>
> ```bash
> PUBLIC_ORIGIN=https://你的域名
> ```

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
- **结尾 `&`**：两种形式都尝试；
- **密钥形式**：文本、十六进制解码、Base64 解码三种字节形式都尝试。

以上候选全部用同一把 API Key 做 HMAC-SHA1 校验，能匹配上的才算通过，因此兼容性处理不会削弱签名强度。

另外，Steam 回跳时可能改写 `return_to` 的查询串（用 `?` 而不是 `&` 拼接，甚至直接丢弃）。为此服务端做了三重保障：

- 登录 `state` 同时写入一个独立的 `HttpOnly` Cookie，回调时优先从 Cookie 取回；
- `return_to` 的比对放宽为「同源 + 同路径」，不再逐字符比较；
- 签名必需字段放宽为 `signed / claimed_id / identity / ns`，`return_to` 是否参与签名由 Steam 决定。

接口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/auth/login` | 发起登录，跳转 Steam OpenID |
| `GET /api/auth/callback` | 校验签名并建立会话 |
| `GET /api/auth/session` | 读取当前登录状态 |
| `GET /api/auth/debug` | 查看当前生效的回调地址与域名检查提示 |
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

**也可以在后台自助改密码**：登录管理后台后，「修改登录密码」面板里填当前密码、新密码和确认新密码即可，改完立刻生效，其它设备上已登录的管理员会话会被强制下线。

| 规则 | 说明 |
| --- | --- |
| 长度 | 至少 8 位，最多 128 位 |
| 复杂度 | 必须同时包含字母和数字 |
| 校验 | 必须先验证当前密码，不能与当前密码相同 |
| 存储 | PBKDF2-SHA512（12 万次迭代）＋随机盐，只存哈希，不存明文 |
| 副作用 | 改密后其它管理员会话立即失效；当前会话保留 |
| 与环境变量的关系 | 凭据文件会记录来源。**在后台改过密码后**（`source = ui`），环境变量不再覆盖它；只有在凭据仍来自环境变量（`source = env`）时，`ADMIN_PASSWORD` 变更才会生效 |

> **在后台改过密码之后**，环境变量就不再覆盖它了（凭据文件会记录 `source = ui`）；只有凭据仍来自环境变量时，`ADMIN_PASSWORD` 的变更才会生效。

后台功能：

| 区域 | 内容 |
| --- | --- |
| 运行状态 | 版本、运行时长、是否配置 API Key、区服数、缓存条目、登录会话数、Node 版本 |
| 玩家称号 | 在线增删改称号（SteamID64、名称、颜色、优先级），保存后立即生效并持久化到 `data/titles.json` |
| 修改登录密码 | 验证当前密码后设置新密码 |

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

## 未公开 / 已下架游戏的查询

商店接口只提供「当前在售」的游戏数据。查不到时服务端会按顺序兜底：

| 顺序 | 来源 | 能拿到什么 | 标记 |
| --- | --- | --- | --- |
| 1 | 换区服的商店接口 | 与正常页面完全一致的完整数据（含价格） | `store-region` |
| 2 | Steam appinfo 协议（PICS） | 名称、开发商、发行商、发售日期、DLC 列表 | `appinfo` |
| 3 | Steam Web API 应用列表 | 游戏名称、类型、上架时间 | `webapi` |

页面顶部会显示当前数据的来源与说明，不会把受限数据伪装成正常商店数据。

第 1 步解决的是**区服限制**：很多游戏在国区被单独下架，但在美区、日区等仍然可以买到。比如国区查不到的游戏会自动从其它区服取数据并标注来源区服。区服扫描分两轮（先试美日德台港，再试东南亚韩国巴西俄罗斯法国），只有当游戏还留在 Steam 应用列表里时才会跑第二轮，避免无谓地消耗接口额度。

第 2 步是 `appinfo.mjs` 模块实现的 Steam Content Server 协议（就是 steamcmd 读资料用的那套）。协议细节对照 [SteamRE/SteamKit2](https://github.com/SteamRE/SteamKit) 与 [DoctorMcKay/node-steam-user](https://github.com/DoctorMcKay/node-steam-user) 的实现：

| 环节 | 内容 |
| --- | --- |
| 服务器列表 | `ISteamDirectory/GetCMListForConnect/v1/` 取官方 CM 节点 |
| 传输 | 明文 TCP 27017，每帧为 `长度 + "VT01" 魔数 + 数据` |
| 通道加密 | RSA-OAEP-SHA1 挑战应答 + NetFilter（AES-256-CBC + HMAC-SHA1，IV = HMAC ‖ 随机数） |
| 握手 | `CMsgClientHello` → 匿名 `CMsgClientLogon`（`anon_user_target_account_name = "anonymous"`） |
| 资料请求 | `CMsgClientPICSProductInfoRequest` → `CMsgClientPICSProductInfoResponse` |
| 消息打包 | 服务器会把多条消息装进 `Multi`（EMsg 1），必要时还会 gzip 压缩 |
| 资料格式 | VDF 文本（`"appinfo" { ... }`） |

全流程纯 Node 实现，没有任何第三方依赖。

> **能力边界**：PICS 只能查到 Steam 数据库里还在的应用。例如 App ID 999（Painkiller Overdose Trailer）、3000（GTI Racing）、5000（Painkiller Overdose Teaser）商店接口完全查不到，但 PICS 能给出名称、开发商与发售日期。
>
> 而彻底从 Steam 下架、Valve 同时从数据库里清掉的游戏（例如 Evolve 280490、Rise of the Tomb Raider 391990、Mafia III 270320），任何公开接口都查不到——这不是本项目的限制，而是 Steam 侧已经没有这份数据了。此时站点会明确返回「没有找到这款游戏」，而不是编造内容。

### 请求节流

Steam 对突发请求很敏感，连续密集请求会收到 403 甚至被临时限制。因此服务端做了：

- 商店接口最小请求间隔 220ms；
- 收到 403 / 429 后进入 90 秒全局冷却，期间不再请求 Steam；
- 查询失败的游戏会缓存 30 分钟，避免反复扫描各区服；
- 整个解析结果缓存 10 分钟，重复访问几乎不产生新的请求；
- appinfo 协议走的是 Steam 的 CM 服务器，不占用商店接口的额度。

## 搜索已下架的游戏

Steam 的搜索接口（`storesearch` / `search/suggest`）只收录**仍在售**的游戏，一款游戏下架后就再也搜不到；Web API 的应用列表（`IStoreService/GetAppList`）同样不含下架条目。老的 `ISteamApps/GetAppList` 已被 Valve 下线（返回 404）。

但 Steam 的 appinfo（PICS）协议里仍然保留着这些游戏的资料——只要知道 App ID。

所以本站自己扫一遍 App ID 空间：

| 环节 | 说明 |
| --- | --- |
| 扫描 | 用批量 PICS 请求遍历 App ID 空间（1 ~ 4,000,000） |
| 批次 | 一次 100 个 App ID、4 条连接并行。**批次不能开大**：服务端回应的缓冲区装不下时会把后面的 App ID 静默丢掉（实测一次 800 个会漏 600 多个，100 个一个不漏） |
| 游标 | 服务端按 App ID 顺序处理，每条连接自带位置。扫描器跟着服务端的位置走，并检测回应区间是否连续，缺口会重新问一遍 |
| 提取 | 从 VDF 资料里取名称、类型与发售日期 |
| 存储 | 写入 `data/app-index.json`（已 gitignore，不进仓库） |
| 检索 | 内存里按名称做「完全匹配 → 前缀匹配 → 包含匹配」三级检索，游戏排在原声带 / DLC 前面 |
| 合并 | 商店搜索结果在前，本地索引补在下架游戏后面，标「已下架」 |

整个 App ID 空间约 22 万条索引，扫完需要 20~30 分钟。索引会在服务启动后于后台自动续扫（断点续扫，用带心跳的锁文件避免与命令行重复跑）。也可以手动跑：

```bash
node build-index.mjs              # 从上次进度继续
node build-index.mjs --from=1     # 从头开始
```

设 `STEAM_INDEX_SCAN=0` 可关闭后台扫描。

> 已从 Steam 数据库彻底删除的游戏（Evolve 280490、Rise of the Tomb Raider 391990 等）不在 PICS 库里，索引里也不会有——这不是索引的缺陷，是 Steam 侧已经没有这份数据了。
> 另外，Steam 给一部分早期应用（多半是原声带与预告片）只留了空壳资料、没有名称，这些也不会进索引。

## Valve 员工识别与防诈骗提醒

Valve 员工的 Steam 资料页上会挂一条官方横幅（`profile_header_valve_employee`）和一枚 `ValveEmployee` 徽章。这个标记**只出现在 HTML 页面里**，公开档案 XML 接口不返回，因此服务端会额外抓一次资料页 HTML 来判定。

判定为 Valve 员工后：

- Steam 名称后面加上 **Valve员工** 称号；
- 资料页顶部显示黄色提示框，写明 Valve 员工不会通过 Steam 聊天或 Discord 联系用户，并给出 [Steam欺诈常见问题](https://help.steampowered.com/zh-cn/faqs/view/70E6-991B-233B-A37B) 链接。

判定完全依据 Steam 自己给出的标记，不做主观推测；Steam 没有标记的账号（例如资料设为私密且未公开员工横幅的账号）不会被标成员工。

## 部署说明

GitHub Pages 只能运行静态文件，不能运行 `server.mjs`。如需实时功能，请将 Node 服务部署到 Render、Railway、Fly.io 或自己的 VPS，再把前端 API 地址改为后端地址。

## 安全与隐私

- Steam API Key 通过 AES-256-GCM 加密存储在 `.steam-key.enc`，解密密钥在 `.steam-key.secret`；两者均已加入 `.gitignore`，不会进入仓库。
- 更换 Key：`node set-key.mjs <32位十六进制Key>`。Key 失效或被 Steam 限流时，站点会自动降级到公开档案与 appinfo 协议，商店资料、区服价格与下架游戏搜索仍然可用。
- 本项目不是 Valve / Steam 官方产品，与 Valve 无隶属关系。
- 私密或仅好友可见的数据由 Steam 隐私设置决定，本站不会绕过隐私设置。
- 区服人民币金额为公开汇率估算，实际结算以 Steam 商店为准。

## 项目结构

```text
steam-web/
├─ index.html              # 无 Node.js 静态预览 / GitHub Pages 首页
├─ server.mjs              # 零依赖 Node HTTP 服务 + Steam API 代理
├─ set-key.mjs             # 加密写入 / 更换 Steam Web API Key
├─ appinfo.mjs             # Steam appinfo 协议客户端（读取已下架游戏资料）
├─ appindex.mjs            # App ID 名称索引（让下架游戏能被搜索到）
├─ build-index.mjs         # 命令行扫描 App ID 空间、建立索引
├─ data/
│  ├─ titles.json          # 玩家称号配置（管理后台写入，已入库）
│  ├─ app-index.json       # App ID 名称索引（不入库，后台自动重建）
│  └─ admin.json          # 管理员凭据哈希（不入库）
├─ extension/              # 浏览器扩展（Manifest V3）
│  ├─ manifest.json        # 扩展清单
│  ├─ background.js        # 后台服务：代发 Steam 请求
│  ├─ content.js           # 侦测浏览器已登录的 Steam 账号
│  ├─ panel.html/.css/.js  # 面板界面（弹出窗口 / 侧边栏）
│  └─ README.md            # 安装与使用说明
├─ test/
│  ├─ openid.test.mjs      # Steam OpenID 登录握手的端到端测试
│  └─ appinfo.test.mjs     # VDF 解析与资料字段抽取的单元测试
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
| `/api/dlc/:id` | 解析该游戏的 DLC 列表（名称、价格、发售日期） |
| `/api/profile` | Steam Web API 或 `steamcommunity.com/.../?xml=1`，另抓一次 HTML 判断 Valve 员工 |
| `/api/auth/*` | Steam OpenID 2.0 + Steam Web API 校验 |
| 汇率估算 | `open.er-api.com`，失败时回退 `frankfurter.app` |

## 测试

服务启动后可运行 OpenID 登录握手的端到端测试（会本地解密 Key，仅用于签名校验，不会打印）：

```bash
node test/openid.test.mjs
```

appinfo 模块的 VDF 解析与字段抽取单元测试（离线，不联网）：

```bash
node test/appinfo.test.mjs
```

## 许可证

本项目采用 **GNU General Public License v3.0（GPL-3.0-or-later）** 开源，详见 [LICENSE](LICENSE)。

## 版权信息

版权所有 © 2026 wangzic

本项目由 AI 编写并在 GPL-3.0-or-later 协议下开源。你可以依据 GPL 协议自由使用、复制、修改和分发本项目，但衍生作品须继续遵守 GPL 协议并保留相应版权与许可证声明。
