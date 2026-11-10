# Steam Atlas 助手（浏览器扩展）

在浏览器内搜索 Steam 游戏、读取个人资料与游戏库，并一键用本机 Steam 客户端启动游戏。

## 功能

| 标签 | 能力 |
| --- | --- |
| **搜索** | 调用 Steam 商店公开接口搜索游戏，结果可直接「启动」「客户端商店」「网页商店」 |
| **我的库** | 读取游戏库、总时长与最近在玩；支持 SteamID64 与个性域名 |
| **账号** | 保存自己的 Steam Web API Key（仅存本机）、查看当前浏览器的登录账号 |

扩展还会在 `steamcommunity.com` 页面自动识别你当前登录的 Steam 账号。

## 安装（开发者模式）

1. 打开 Chrome / Edge 的扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 打开右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本目录 `extension/`。
4. 建议把扩展固定到工具栏，或使用面板里的「侧边栏」按钮固定到侧边。

## 使用 Steam Web API Key（可选）

只有「我的库」和「账号」需要 Key：

1. 访问 <https://steamcommunity.com/dev/apikey>，登录后申请一把 Key。
2. 在扩展的 **账号** 标签粘贴并保存。
3. 粘贴 SteamID64、个性域名或主页链接，点「读取」。

Key 只写入本机扩展存储 `chrome.storage.local`，只在访问 `api.steampowered.com` 时使用，不会发送给 Steam Atlas 网站或任何第三方。

## 启动游戏

扩展里的「启动」按钮使用 Steam 官方协议链接：

```text
steam://run/<appid>      启动游戏
steam://store/<appid>    在客户端中打开商店页
```

如果浏览器提示「未知协议」，说明本机没有安装 Steam 客户端或没有注册 `steam` 协议，此时请改用「网页」按钮。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存本机 API Key 与侦测到的账号 |
| `tabs` / `sidePanel` | 在侧边栏中打开面板 |
| `api.steampowered.com` | Steam Web API：资料、游戏库、最近游玩、封禁 |
| `store.steampowered.com` | Steam 商店搜索与游戏详情 |
| `steamcommunity.com` | 侦测当前登录的 SteamID（只读） |

## 相关

- 完整网站（含同样的启动游戏功能）：<https://github.com/project-steamweb/project-steamweb.github.io>
- 本扩展由 AI 编写，依据 GPL-3.0-or-later 开源。
