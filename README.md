# 🔀 Clash Proxy

> 版本跟随：`2.5.2-1`（与 Clash Verge 网址代理版 `clash-verge-url-proxy` 保持一致）

给 **agent / 脚本** 用的 mihomo 节点选择 CLI。**下载前为任意 URL 自动测出延迟最低的节点并切换**，随后走代理下载。可**自动建「网址代理」组**（配合 Clash Verge 网址代理版），也可复用已建好的组。**`dl` 命令把「选节点」和「多线程下载」合成一步**，下载前自动切最优节点、再用多线程引擎下载（aria2c 主引擎由安装脚本自动安装，JSON-RPC 控制拿结构化进度与精确错误分类；未装时用内置零依赖 Node 分片下载器兜底）。

## 简介

Clash Proxy 是一个 **Node 零 npm 依赖** 的命令行工具，直接连接 [Clash Verge（网址代理版）](https://github.com/likangdi-code/clash-verge-url-proxy) 内置的 mihomo（Windows 命名管道 / macOS·Linux Unix socket，免配置、无 secret）。它解决一个具体问题：**下载文件之前，先针对下载链接选出最快的节点，再开始下载**——尤其适合 AI agent 自动执行。

```
下载链接 ──▶ clash-proxy add/pick <url> ──▶ 自动命中网址代理组（无则 add 自动建组）
                                                │ 并发测速（针对该 URL）
                                                ▼
                                        切到延迟最低的节点
                                                │
                                  curl --proxy http://127.0.0.1:7897 -L -O <url>
                                  clash-proxy dl <url>（选节点 + 多线程下载一步完成）
```

## Preview

```console
$ clash-proxy add "https://example.com"

✓ 已创建网址代理组 URL-Proxy-ptDiIw（example.com）
组: URL-Proxy-ptDiIw  测速节点: 71 个
✓ 已切换 URL-Proxy-ptDiIw → 距离下次重置剩余：17 天 (46 ms)
下载: curl --proxy http://127.0.0.1:7897 -L -O 'https://example.com'
```

## 与 Clash Verge（网址代理版）联合使用

Clash Proxy 与 [Clash Verge（网址代理版）](https://github.com/likangdi-code/clash-verge-url-proxy) 是**同一个体系的两面**——共用同一份「网址代理」组与规则：

| | Clash Verge（网址代理版）GUI | Clash Proxy CLI |
|---|---|---|
| 角色 | 可视化管理「网址代理」 | 自动化测速选节点 |
| 建组 | 界面手动新建 `URL-Proxy-*` 组 | `add` 全自动建组（走命令桥） |
| 选节点 | 手动点击 / ⚡ 测速 / AUTO | `pick` 自动切最低延迟 |
| 适用 | 日常手动使用 | agent / 脚本 / 下载自动化 |

**联合工作流（AI agent 下载场景）**：

```bash
# 0. 最快方式：选节点 + 多线程下载一步完成（推荐）
clash-proxy dl "https://example.com/big-file.zip" --json
#    → 自动建 URL-Proxy-* 组 + 测速切最优节点 + 走代理多线程下载，一次搞定

# 1. 或分步：agent 拿到下载链接，全自动建组 + 选最优节点（Verge 在跑即可）
clash-proxy add "https://example.com/big-file.zip" --json
#    → 该域名没建过组时自动建 URL-Proxy-* 组（写增强文件 + reload，命令桥完成）

# 2. 走 mihomo 混入端口下载（命中网址代理规则 → 走刚选中的节点）
curl --proxy http://127.0.0.1:7897 -L -o big-file.zip "https://example.com/big-file.zip"
#    或：clash-proxy dl "https://example.com/big-file.zip"（内置多线程下载器）

# 3. 打开 Clash Verge 的「网址代理」页 → 能看到刚才自动建的组，随时手动调整节点
```

- **共用同一份组/规则**：GUI 建的组，CLI 能 `pick`；CLI `add` 建的组，GUI 能看到并可手动管理。两者操作同一个 mihomo 内核与增强文件。
- **互补**：GUI 适合可视化巡检和手动微调，CLI 适合把「下载前选最优节点」自动化（尤其 agent 自主执行）。

> ⚠️ `add` 依赖 Verge 的**命令桥**（`/commands/profile-save`），需要**含命令桥的构建**（本次发布的安装包已含此能力）。旧版 Verge 仍可用 `pick`（对已建组测速切换）。

## 快速开始

### 安装工具

**Windows**（PowerShell 终端一行）：

```powershell
irm https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.ps1 | iex
```

**macOS / Linux**（终端一行）：

```sh
curl -fsSL https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.sh | sh
```

安装后新开终端即可用 `clash-proxy`。需要 Node.js（≥18）。

**Windows 安装流程**：装完工具后弹出**方向键多选菜单**选择把 skill 部署到哪些本机 agent 工具——菜单**始终列出全部 7 个**（Claude Code / Gemini / Codex / OpenCode / Hermes / OpenClaw / Grok），本机已检测到的默认选中（`▣` 青色），未检测到的置灰并标注「不可选」：`↑/↓` 移动光标、`空格` 切换选中（`▣`→`▢`）、`Enter` 任意位置直接确认部署、`Esc` 跳过，选好后自动部署 `clash-proxy` + `clash-proxy-fix` 两个 skill。

**本命令兼作更新命令**：再次运行即更新工具与 skill（幂等，不产生重复 PATH 条目）。更新前先查 GitHub API 的最新 commit（`%LOCALAPPDATA%\Programs\clash-proxy\.version` 记录上次版本）并对每个文件做 **git blob SHA-1 哈希比对**：只有变化的文件才重新下载（下载后再校验哈希，CDN 缓存延迟自动重试），全部一致则提示「已是最新」直接跳过；删除 `.version` 再重跑 = 强制重装。GitHub API 不可用时自动降级为直接覆盖下载（不校验、不卡住）。交互选择会重新询问，随时可调整部署目标。

### 平台支持

| 平台 | 连接 mihomo | 安装 |
|---|---|---|
| Windows | 命名管道 `\\.\pipe\verge-mihomo`（免配置） | `install.ps1` |
| macOS | Unix socket `/tmp/verge/verge-mihomo.sock`（免配置） | `install.sh` |
| Linux | Unix socket `/tmp/verge/verge-mihomo.sock`（免配置） | `install.sh` |

clash-proxy 自动检测平台选 IPC 方式；也可用 `CLASH_API` 指向任意 mihomo HTTP external-controller。

### 部署 Agent Skill（让 agent 自主调用）

把 clash-proxy 的两个 **Agent Skill** 部署到本机**所有已装的 AI agent 工具**（Claude Code / Gemini / Codex / OpenCode / Hermes / OpenClaw / Grok），结束后汇总「已安装到哪些 / 未检测到哪些」：

- `clash-proxy` — 工具使用说明（下载/选节点）
- `clash-proxy-fix` — 安装与排障修复

```powershell
# Windows: powershell · macOS/Linux 需 pwsh（brew install powershell）
powershell -ExecutionPolicy Bypass -File deploy-agents.ps1
# 只装到指定 agent（如 Claude Code）：
powershell -ExecutionPolicy Bypass -File deploy-agents.ps1 -Agent claude
```

装好后对应 agent 在「下载 / 选节点 / 走代理」场景下会**自主调用** clash-proxy，无需手动敲命令。

## 使用教程（Agent 下载流程）

1. **一键选节点 + 多线程下载**（推荐）：
   ```bash
   clash-proxy dl "https://example.com/big-file.zip"   # 建组(无则) + 切最优节点 + 走代理多线程下载
   ```
2. **分步**：先建组选节点，再下载：
   ```bash
   clash-proxy add "https://example.com/big-file.zip"   # 没建过组 → 自动建；已建 → 复用
   ```
   或仅对已建组测速切换：`clash-proxy pick "https://example.com/big-file.zip"`
3. 走 mihomo 混入端口下载：
   ```bash
   curl --proxy http://127.0.0.1:7897 -L -o big-file.zip "https://example.com/big-file.zip"
   ```

## 核心功能

- **子命令**：`add <url>`（自动建组 + 测速切换）、`pick <url>`（测速切换已有组）、`test <url>`（只测速）、`dl <url>`（选节点 + 多线程下载一步完成）、`list`、`current`
- **`--json` 输出**：机器可读（bestNode / bestDelay / group / top），供 agent 程序化解析
- **自动命中网址代理组**：从 mihomo `/rules` 探测 `DOMAIN-SUFFIX` 规则 → `URL-Proxy-*` 组；命中多个取最具体的域名
- **无命中回退 GLOBAL**：未建组的域名切 GLOBAL（rule 模式下未匹配规则的流量走它）
- **针对 URL 精确测速**：`GET /proxies/{name}/delay?url=<url>`
- **`dl` 一体化下载**：选完节点直接用多线程引擎下载（见下「多线程下载引擎」）
- **`clash-dl` 独立下载命令**：下载器与选节点解耦，可单独使用（见下）

### 选项与环境变量

| 选项 | 说明 |
|---|---|
| `--group <组名>` | 指定切换的组（默认自动探测） |
| `--timeout <ms>` | 单节点测速超时（默认 5000） |
| `--concurrency <n>` | 并发测速数（默认 12） |
| `--top <n>` | 只显示延迟最低的前 n 个 |
| `--json` | 输出 JSON |
| `--no-switch` | 只测速不切换 |

`dl` 专属选项：

| 选项 | 说明 |
|---|---|
| `-o, --output <文件>` | 下载输出文件名（默认从 URL / Content-Disposition 推断） |
| `-d, --dir <目录>` | 下载保存目录（默认当前目录） |
| `-t, --threads <n>` | 并发线程数（默认 8） |
| `-H, --header <头>` | 自定义 HTTP 头，可多次（非公开 URL 认证用，如 `"Authorization: Bearer xxx"`） |
| `--no-proxy` | 直连下载，不走代理、不选节点 |
| `--force-node` | 强制用内置 Node 下载器（不探测 aria2c） |

| 环境变量 | 说明 |
|---|---|
| `CLASH_API` | 覆盖端点，如 `http://127.0.0.1:9097`（默认命名管道 / Unix socket） |
| `CLASH_SOCK` | 覆盖 Unix socket 路径（macOS/Linux） |
| `CLASH_PIPE` | 覆盖 Windows 命名管道路径 |
| `CLASH_SECRET` | HTTP 模式下的 secret（socket/pipe 传输无需 secret） |
| `CLASH_MIXED_PORT` | 下载命令提示的代理端口（默认 7897） |

## 多线程下载引擎（`dl` 命令 / `clash-dl` 独立命令）

下载引擎是一个**独立可用的部分**，与选节点解耦：

- **`clash-dl <url>`** — 独立多线程下载命令（与 `clash-proxy` 平级入口），选节点与下载分开：先用 `clash-proxy pick/add` 选好节点，再随时用 `clash-dl` 下载。
- **`clash-proxy dl <url>`** — 一键快捷方式，把「选节点 + 下载」合并成一步。

两者共用同一个下载引擎，效果相同。`clash-dl` 也支持代理直连（`--no-proxy`）、线程数（`-t`）、输出目录（`-d`）等所有 `dl` 选项。

**独立使用示例（先选节点，后下载）**：

```bash
# 1. 先选节点（自动建组 + 切最低延迟）
clash-proxy add "https://github.com/owner/repo/releases/download/v1.0/app.zip"

# 2. 随时用独立下载命令下载（自动走 7897 代理，命中刚切的节点）
clash-dl "https://github.com/owner/repo/releases/download/v1.0/app.zip" -d ~/Downloads -t 8

# 3. 或一步到位
clash-proxy dl "https://github.com/owner/repo/releases/download/v1.0/app.zip" -d ~/Downloads -t 8
```

引擎采用**混合三层**（逐级回退）：

| 引擎 | 触发条件 | 能力 |
|---|---|---|
| **aria2 JSON-RPC**（主路径） | aria2c 可用（安装脚本已自动安装） | 多连接分片、断点续传、走代理（`all-proxy`）；**JSON-RPC 控制**：结构化进度（字节级，`--json` 模式也准确）、精确错误分类（超时 / 404 / 磁盘满 / 认证失败，来自 `errorCode`/`errorMessage`）；node 退出 aria2 自动退出，Ctrl+C 中断后下次自动续传 |
| **aria2c legacy spawn**（回退） | RPC 实例起不来 | 一次性 spawn aria2c（只拿退出码，aria2c 自带进度条） |
| **内置 Node 下载器**（兜底） | 未装 aria2c（零依赖） | HTTP Range 分片并发下载到 `.part`，完成后拼接；断点续传（完整分片自动跳过）；不支持 Range 或大小未知时自动降级单线程；支持 http 直发代理 / https CONNECT 隧道 |

- **aria2c 由安装脚本主动安装**：Windows 下载官方二进制到安装目录 `bin\`（GitHub release，SHA256 校验）；macOS/Linux 走 brew/apt/dnf/pacman。已在 PATH 的 aria2c 直接复用。安装失败不阻塞（内置 Node 下载器兜底）。
- **断点续传**：中断后重跑同 URL 同目录，未完成的分片（`.part*`）自动续传；已完整文件直接跳过。
- **Clash 离线兜底**：`dl` 检测不到 Clash 时自动改直连下载（不报错卡住）；`--no-proxy` 可强制直连。
- **非公开 URL（需认证）**：用 `-H/--header "Name: value"` 指定认证头（可多次），下载时自动透传给探测 / 分片 / 单线程 / aria2c。若目标是不支持多连接的一次性签名 / 受限 URL，多线程分片遇 401/403/429 会自动降级为单线程完整下载，避免整体失败。

### 非公开 URL 下载示例

```bash
# 下载需要认证的文件（私有 GitHub Release / API / 签名 URL）
clash-dl "https://example.com/private/file.zip" \
  -H "Authorization: Bearer <token>" \
  -H "Cookie: session=abc123"

# 或走 clash-proxy dl（选节点 + 下载一步）
clash-proxy dl "https://example.com/private/file.zip" -H "Authorization: Bearer <token>"

# 一次性签名 / 受限 URL：多线程分片遇 403 时自动降级单线程，文件仍完整下载
clash-dl "https://cdn.example.com/signed-url?sig=xxx"
```

**示例**：

```bash
# 建组 + 选最优节点 + 走代理多线程下载（一步完成）
clash-proxy dl "https://github.com/owner/repo/releases/download/v1.0/app.zip" -d ~/Downloads -t 8

# 已装 aria2c 时同上，自动用 aria2c 多连接满速下载
# 强制用内置 Node 下载器：
clash-proxy dl "https://example.com/file.bin" --force-node

# 不需要代理，直连多线程下载：
clash-proxy dl "https://example.com/file.bin" --no-proxy

# 机器可读输出（供 agent 解析）：
clash-proxy dl "https://example.com/file.bin" --json
```

> **aria2c 通常无需手动安装**——安装脚本会自动装（Windows 官方二进制 → 安装目录 `bin\`；macOS/Linux 走包管理器）。若自动安装失败，可手动：
> - Windows：`winget install aria2.aria2` 或到 [aria2 Releases](https://github.com/aria2/aria2/releases) 下载
> - macOS：`brew install aria2`
> - Linux：`sudo apt install aria2`（Debian/Ubuntu）或 `sudo dnf install aria2`（Fedora）

## 特性

- **零配置**：走 Verge 命名管道 / Unix socket，免开 external controller、免 secret
- **零 npm 依赖**：纯 Node + vendored js-yaml，无需 `npm install`
- **针对 URL 精确测速**，而不是用固定测试站
- **并发测速**（默认 12 路），全节点秒出结果
- **自动建组**：`add` 全自动写增强文件 + reload（走 Verge 命令桥）
- **`dl` 一体化多线程下载**：选节点 + 下载一步完成，aria2c 有则用（JSON-RPC 结构化进度与错误分类）、无则内置 Node 分片下载
- **`--json`** 结构化输出，天然适配 agent 工具调用
- **幂等安装脚本**：重复运行只更新不产生重复 PATH 条目

## 工作原理

1. 解析 URL → 域名
2. `GET /proxies` 拿节点与组；`GET /rules` 探测命中的网址代理组
3. `add`：读当前订阅增强文件 → 生成 `URL-Proxy-*` 组 + `DOMAIN-SUFFIX` 规则 → 经 Verge 命令桥写盘 + 校验 + reload
4. 组内节点**针对该 URL** 并发测速
5. `PUT /proxies/{group}` 切到延迟最低的节点

## 开发

零 npm 依赖的 Node 脚本，无需构建：

```bash
git clone https://github.com/likangdi-code/clash-verge-url-proxy-cli
cd clash-verge-url-proxy-cli
node clash-proxy.mjs list        # 直接运行
```

前置：本机运行着 Clash Verge（网址代理版）（或任意暴露 external-controller 的 mihomo，用 `CLASH_API` 指定）。

## 致谢

- [clash-verge-url-proxy](https://github.com/likangdi-code/clash-verge-url-proxy) — 「网址代理」功能、组/规则机制与命令桥
- [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) — Clash Verge Rev 项目
- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) — mihomo 内核与 external-controller API

## License

[GPL-3.0](LICENSE)
