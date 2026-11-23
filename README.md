# 麦禾 VPN — Windows 11 桌面版

手机优先的思路搬到桌面：Electron + sing-box 核心，接你自己的 Cloudflare 节点。应用名“麦禾 VPN”，图标为绿色盾牌 + 闪电，界面仿 ShieldFlow 模式。

> ⚠️ 重要限制（先读这段，再谈赚钱）：
>
> 本程序**不内置任何节点、不带服务器**：第一次打开节点列表是空的，需要你自己有节点（粘贴 VLESS 链接、导入订阅或手动添加）才能用。
> 这不是多地区服务器群，没有 30+ 服务器、没有全球节点。
> 因此：
> - 本程序不能向他人承诺“多地区 / 无限付费服务”；
> - Pro 的“不限流量 / 全部节点”目前是**本地占位**：应用内显示不限流量、去掉限制，但后端容量并没有变；
> - 在接上真实 VPS 节点（多台、多地区）之前，**不要用 Pro 向他人收费**，也不要在商店描述、截图或广告里写全球节点、多地区、30+ 服务器。
> - 首页、Pro 页、关于页里都写了同一段限制文案，改文案前先把后端接好。
> - 免费额度（每日 500 MB、每月 10 GB）是**本机本地记账**：没有账号、没有服务端，换电脑 / 清数据后额度会重置，不能当成服务端的防刷限流。

## 界面（ShieldFlow 模式）

- 大盾牌图标（绿盾 + 白闪电，点一下就是连接开关）；
- 一键连接 / 断开，状态只认 sing-box 子进程的真实状态：**已连接 / 未连接 / 连接中 / 连接失败**（“已选中节点”绝不写成“已连接”）；
- 实时速率（↓/↑）：主进程每秒轮询 sing-box 本机 Clash API（`127.0.0.1:9090/connections`）汇总得出；若 API 不可用，显示 0，不伪造数字；
- 本次连接流量、已连接时长；
- **自动选最快**：对全部节点做一次可达性探测，选延迟最低的设为当前节点（这是可达性探测，不是代理延迟，仅供参考）；
- 出口 IP 检测：连接前后各查一次 Cloudflare trace，IP 变了才说明流量走了节点；
- 节点管理：设为当前 / 测速 / 删除；
- 今日免费流量进度条。

## 免费版 vs Pro（占位）

| | 免费版 | Pro（本地占位） |
|---|---|---|
| 每日流量 | 500 MB | 应用内不限（占位） |
| 每月流量 | 上限 10 GB | 应用内不限（占位） |
| 设备 | 1 台（本机安装，无账号、无服务端校验） | 同上 |
| 节点 | 自己导入 | 全部节点 |
| 广告 | Windows 版无广告 | 无广告 |

Windows 版**没有 AdMob**：AdMob 是移动广告 SDK，不适用于 Windows 桌面。Windows 的赚钱以后走 Pro / 网站结账（例如在网站上卖 Pro 兑换码，或接 Stripe / PayPal），不在 App 内放广告。商品 ID（待定）：`maihe_vpn_pro_windows` —— 在确定收款方案后才填写，代码里没有任何真实价格。

额度代码位置：`src/quota.js`（每日 500 MB、每月 10 GB）、`main.js`（连接前检查额度、断开时结算）。

## 节点：不内置，自己导入

- 第一次打开列表是空的。自己加节点：粘贴 `vless://…` 链接、导入订阅，或手动填写。
- 程序里不写任何 UUID，节点只保存在本机。
- 支持解析 `vless://`、`vmess://`、`trojan://`、`ss://`（`src/nodeParser.js`，渲染层 `renderer/app.js` 里有同一规则的小实现）。
- sing-box 配置由 `src/singboxConfig.js` 生成（mixed 入站 127.0.0.1:2080 + 当前节点出站 + DNS 防泄漏 + 本机 Clash API）。

## 工作原理（不要跳过）

1. 你在界面点盾牌 → 主进程 `main.js` 先检查免费额度 → 生成 sing-box JSON 配置 → 先跑 `sing-box check` 校验 → 再启动 `sing-box run` 子进程。
2. 校验或启动失败 → 状态为“连接失败”，并显示具体错误，**绝不显示“已连接”**。
3. 启动成功 1.5 秒后进程还在 → 状态为“已连接”，主进程开始每秒轮询 Clash API 统计实时速率。
4. 默认是**系统代理模式**：sing-box 在本机 127.0.0.1:2080 提供 HTTP + SOCKS5 代理。连接成功后，你需要把 Windows 系统代理指向它：首页点“打开 Windows 代理设置”，手动填 `127.0.0.1` 端口 `2080`；或用浏览器 / 其他工具的代理设置指向同一地址。只启动 sing-box、不设系统代理，浏览器流量是不会走节点的——首页“检测出口 IP”就是用来验证这一点的。

### TUN 模式（可选，需要管理员权限）

默认不启用 TUN。如需全系统接管（所有程序都走节点，不用手动设代理）：

1. 把 `src/singboxConfig.js` 里 `buildSingBoxConfig(node, { mode: 'system-proxy' })` 的调用（在 `main.js` 的 `startVpn` 里）改为 `{ mode: 'tun' }`；
2. 以管理员身份运行本程序（右键 .exe → 以管理员身份运行）；
3. 确保 sing-box 的 TUN 驱动已正确安装（sing-box 官方文档有说明；不同版本要求不同，装不上就退回系统代理模式）。

## 在 Windows 11 上运行（开发调试）

### 1. 安装 Node.js

1. 打开 https://nodejs.org ，下载 LTS 版（建议 Node 20 或更新，安装时勾选 “Add to PATH”）；
2. 装完后打开 PowerShell，运行 `node -v` 和 `npm -v`，都能显示版本号才算装好；
3. 把本工程文件夹 `maihe-vpn-windows/` 复制到 Windows 电脑上（例如 `D:\maihe-vpn-windows\`）。

### 2. 下载 sing-box（Windows 版）

1. 打开 sing-box 官方发布页：https://github.com/SagerNet/sing-box/releases
2. 下载最新版的 Windows 压缩包，例如 `sing-box-1.11.x-windows-amd64.zip`（x64 电脑选 amd64）；
3. 解压后把里面的 `sing-box.exe` 复制到本工程的 `bin/` 目录（和 `bin/README.txt` 同一目录）；
4. （可选）在 PowerShell 里跑 `.\bin\sing-box.exe version`，能显示版本号才算放对了。

**没有 `sing-box.exe` 时程序会明确报错，绝不假装已连接。** 不要从不明网站下载 sing-box，只从上面这个官方发布页下载。

### 3. 安装依赖并运行

在工程目录打开 PowerShell，依次运行：

```powershell
npm install
npm start
```

- `npm install` 会下载 Electron、electron-builder（首次较慢，需要联网）；
- `npm start` 会打开 420×760 的桌面窗口；
- 首次打开列表是空的，先粘贴自己的 VLESS 链接或导入订阅，再点盾牌连接；
- 点盾牌连接 → 系统代理按上面“工作原理”第 4 步设置 → 点“检测出口 IP”，IP 变了才说明通了。

### 4. 检查语法（可选）

```powershell
npm run check
```

它会对 `main.js`、`preload.js`、`src/*.js`、`renderer/app.js` 做 `node --check`，全部通过会输出 `OK`。

## 打包成 .exe 安装包（必须在 Windows 上做）

**本安装包不能在 Linux / macOS 上完整打出 Windows .exe，必须在 Windows 11 电脑上打包。**

1. 确认 `bin/sing-box.exe` 已放好（打包时会一起打进安装包）；
2. 图标：`assets/` 里现在只有 `icon.svg`。electron-builder 在 Windows 上需要 `assets/icon.ico`。请先把 SVG 转成 ICO（例如用在线转换或 ImageMagick），保存为 `assets/icon.ico`，再打包；没有 ICO 时打包会报错或用默认图标；
3. 在工程目录打开 PowerShell，运行：

```powershell
npm run dist
```

4. 完成后在 `dist/` 目录找到安装包（例如 `麦禾 VPN Setup 0.1.0.exe`），双击安装即可；
5. 只生成不安装的目录版：`npm run dist:dir`，在 `dist/win-unpacked/` 里直接运行 `麦禾 VPN.exe`；
6. 正式发给别人前，用 `electron-builder` 的签名配置给 .exe 签名（需要代码签名证书；未签名时 Windows SmartScreen 会提示“未知发布者”，用户需点“仍要运行”）。

## 文件清单

| 文件 | 作用 |
|---|---|
| `package.json` | Electron + electron-builder 配置，`npm start` / `npm run dist` 入口 |
| `main.js` | 主进程：窗口、sing-box 子进程启动/停止、配置校验、Clash API 流量轮询、额度检查、IPC |
| `preload.js` | 安全桥：只暴露最小 API 给渲染层，不暴露 Node 能力 |
| `renderer/index.html` | 界面结构（首页 / 节点 / Pro / 关于） |
| `renderer/styles.css` | ShieldFlow 风格样式（绿盾、深色） |
| `renderer/app.js` | 渲染层逻辑：节点增删改查、订阅导入、测速、自动选最快、出口 IP、额度显示、Pro 占位 |
| `src/nodeParser.js` | 节点链接解析（vless / vmess / trojan / ss）与订阅解析 |
| `src/singboxConfig.js` | sing-box JSON 配置生成（系统代理 / TUN、DNS、Clash API） |
| `src/quota.js` | 免费额度规则（每日 500 MB、每月 10 GB，本地执行） |
| `assets/icon.svg` | 绿盾 + 闪电图标（SVG 源文件；打包需另转 ICO） |
| `bin/README.txt` | sing-box.exe 放置说明（本目录源码里是空的） |
| `README.md` | 本文件 |

## 常见问题

- **点了连接，状态还是“连接失败”**：先看首页红字报错。最常见的是 `bin/sing-box.exe` 没放对，或 sing-box 版本与配置不兼容。按上面第 2 步重新下载官方最新版再试。
- **显示“已连接”，但 IP 没变**：系统代理还没设。按“工作原理”第 4 步，把 Windows 系统代理指向 127.0.0.1:2080，再点“检测出口 IP”。
- **速率一直是 0**：sing-box 的 Clash API 没起来（版本差异或端口被占）。连接本身可能已通，以出口 IP 为准；速率只是统计显示，不影响连接。
- **额度用完了**：免费版每日 500 MB、每月 10 GB，次日 / 下月自动重置。Pro 占位只能在应用内解除限制，不能增加后端流量。
- **iOS / 安卓**：不在本工程里。安卓版在 `../maihe-vpn-android/`，iPhone 真 VPN 需要 Xcode + 开发者账号 + Network Extension。

## 还需要你提供的

1. 你自己的节点（粘贴 VLESS 链接、导入订阅或手动添加）；
2. sing-box Windows 版二进制（官方发布页下载，放到 `bin/`）；
3. 一台 Windows 11 电脑（装 Node.js、跑 `npm install`、`npm start`、打包 `.exe`）；
4. （以后）真实 VPS 节点——接好之前不要对外收 Pro 的钱、不要宣传多地区；
5. （以后）Pro 收款方案（网站结账 / Stripe / PayPal 等）——定好后再填商品 ID 和价格，现在不要写死价格。
