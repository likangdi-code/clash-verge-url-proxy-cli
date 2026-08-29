# 🔀 Clash Proxy

> 版本跟随：`2.5.2-1`（与 Clash Verge 网址代理版 `clash-verge-url-proxy` 保持一致）

给 **agent / 脚本** 用的 mihomo 节点选择 CLI。**下载前为任意 URL 自动测出延迟最低的节点并切换**，再走代理下载；可自动建「网址代理」组（配合 [Clash Verge 网址代理版](https://github.com/likangdi-code/clash-verge-url-proxy)），也可复用已建好的组。

## 解决什么问题

直接连 Clash 下载有个明显痛点：**默认节点往往不是针对当前下载链接最优的节点**——可能是延迟高、线路绕，甚至对目标站点完全不可达。手动挑节点既慢又不可脚本化。

Clash Proxy 把这个过程自动化：**拿到下载链接 → 针对该链接测出延迟最低的节点 → 自动切换 → 再开始下载**。全程一条命令，尤其适合 AI agent 自主执行。

| 场景 | 手动方式 | Clash Proxy |
| --- | --- | --- |
| 下载前选最优节点 | 打开 GUI 逐个测速、人肉比对 | `dl <url>` 一键完成 |
| GitHub Release 下载慢 | 反复换节点重试 | 针对该 URL 并发测速，一次切到最快 |
| 需要认证的私有文件 | 手工配 header、试节点 | `-H` 透传认证头，自动切节点 |
| agent 自主下载 | 无法脚本化 | `--json` 结构化输出，天然适配工具调用 |

## 快速开始

**Windows**（PowerShell 一行）：

```powershell
irm https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.ps1 | iex
```

**macOS / Linux**（终端一行）：

```sh
curl -fsSL https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.sh | sh
```

安装后新开终端即可用 `clash-proxy`（需 Node.js ≥18）。本命令兼作更新命令，重复运行只更新、不产生重复 PATH 条目。

> 前置：本机运行着 Clash Verge（网址代理版）。安装脚本会主动装好 aria2c（Windows 官方二进制 + SHA256 校验；macOS/Linux 走包管理器），未装时自动用内置 Node 下载器兜底。

## 效果对比

### 一键下载（选节点 + 多线程下载一步完成）

```console
$ clash-proxy dl "https://github.com/owner/repo/releases/download/v1.0/app.zip" -d ~/Downloads

✓ 已创建网址代理组 URL-Proxy-ptDiIw（github.com）
✓ 测速 71 个节点 → 最优: 🇯🇵 日本-01（46 ms）
✓ 已切换 URL-Proxy-ptDiIw → 日本-01
▸ 下载中（aria2c 多连接）… 12.3 MB / 23.5 MB  (52%)
✓ 完成: ~/Downloads/app.zip（耗时 3.2s）
```

对比普通 Clash：同样的 GitHub Release 链接，若默认节点选到了高延迟线路，可能只有几百 KB/s、耗时数分钟甚至反复超时；用 `dl` 会先针对该链接并发测速，切到最快节点再下载，秒级完成。

### 分步使用（建组选节点 / 复用已有组）

```console
$ clash-proxy add "https://example.com"

✓ 已切换 URL-Proxy-ptDiIw → 距离下次重置剩余：17 天 (46 ms)
```

默认只输出这一行结论（agent 友好：切到哪个节点、多少 ms）。要看建组信息、测速排行、curl 命令，加 `--verbose`：

```console
$ clash-proxy add "https://example.com" --verbose

✓ 已创建网址代理组 URL-Proxy-ptDiIw（example.com）
✓ 已切换 URL-Proxy-ptDiIw → 距离下次重置剩余：17 天 (46 ms)
目标: example.com  (https://example.com)
组: URL-Proxy-ptDiIw  测速节点: 71 个
延迟最低:
      46 ms  距离下次重置剩余：17 天 ◀
      52 ms  🇭🇰 香港 | 03
      ...
下载: curl --proxy http://127.0.0.1:7897 -L -O 'https://example.com'
```

### 需要认证的私有文件

```bash
# 私有 GitHub Release / API / 签名 URL：-H 透传认证头，自动切节点
clash-proxy dl "https://example.com/private/file.zip" -H "Authorization: Bearer <token>"

# 一次性签名 / 受限 URL：多线程分片遇 401/403 自动降级单线程，文件仍完整下载
clash-dl "https://cdn.example.com/signed-url?sig=xxx"
```

## 使用教程（Agent 下载流程）

1. **一键选节点 + 多线程下载**（推荐）：
   ```bash
   clash-proxy dl "https://example.com/big-file.zip"   # 建组(无则) + 切最优节点 + 走代理多线程下载
   ```
2. **分步**：先建组选节点，再下载：
   ```bash
   clash-proxy add "https://example.com/big-file.zip"   # 没建过组 → 自动建；已建 → 复用
   clash-proxy pick "https://example.com/big-file.zip"  # 或仅对已建组测速切换
   ```
3. 走 mihomo 混入端口下载：
   ```bash
   curl --proxy http://127.0.0.1:7897 -L -o big-file.zip "https://example.com/big-file.zip"
   ```

## 与 Clash Verge（网址代理版）联合使用

Clash Proxy 与 [Clash Verge（网址代理版）](https://github.com/likangdi-code/clash-verge-url-proxy) 共用同一份「网址代理」组与规则：

| | Clash Verge（网址代理版）GUI | Clash Proxy CLI |
| --- | --- | --- |
| 角色 | 可视化管理「网址代理」 | 自动化测速选节点 |
| 建组 | 界面手动新建 `URL-Proxy-*` 组 | `add` 全自动建组（走命令桥） |
| 选节点 | 手动点击 / ⚡ 测速 / AUTO | `pick` 自动切最低延迟 |
| 适用 | 日常手动使用 | agent / 脚本 / 下载自动化 |

- GUI 建的组，CLI 能 `pick`；CLI `add` 建的组，GUI 的「网址代理」页也能看到并手动管理。
- 两者操作同一个 mihomo 内核与增强文件，互补使用。

> ⚠️ `add` 依赖 Verge 的**命令桥**（`/commands/profile-save`），需**含命令桥的构建**（本次发布安装包已含）。旧版 Verge 仍可用 `pick`（对已建组测速切换）。

## 核心功能

- **子命令**：`add <url>`（自动建组 + 测速切换）、`pick <url>`（测速切换已有组）、`test <url>`（只测速）、`dl <url>`（选节点 + 多线程下载一步完成）、`list`、`current`
- **默认一行结论**：`✓ 已切换 <组> → <节点> (xx ms)`，直连最快时标注「（直连最快）」；`--verbose` / `--top n` 才给完整信息
- **直连也是候选**：测速候选始终包含 `DIRECT`，谁快选谁；选到 `DIRECT` 说明该 URL 直连最优（`bestIsDirect`），照常走代理端口即由 mihomo 直连转发
- **`--json` 输出**：机器可读（bestNode / bestDelay / bestIsDirect / group；`top` 排行需 `--top`/`--verbose`），供 agent 程序化解析
- **自动命中网址代理组**：从 mihomo `/rules` 探测 `DOMAIN-SUFFIX` 规则 → `URL-Proxy-*` 组；命中多个取最具体的域名
- **无命中回退 GLOBAL**：未建组的域名切 GLOBAL
- **针对 URL 精确测速**：`GET /proxies/{name}/delay?url=<url>`，而非固定测试站
- **`dl` 一体化下载**：选完节点直接用多线程引擎下载
- **`clash-dl` 独立下载命令**：下载器与选节点解耦，可单独使用

### 选项与环境变量

| 选项 | 说明 |
| --- | --- |
| `--group <组名>` | 指定切换的组（默认自动探测） |
| `--timeout <ms>` | 单节点测速超时（默认 5000） |
| `--concurrency <n>` | 并发测速数（默认 12） |
| `--top <n>` | 附带输出延迟最低的前 n 个（默认不列排行） |
| `--verbose, -v` | 输出完整信息：目标 / 组 / 测速排行（默认前 10）/ curl 命令 |
| `--json` | 输出 JSON（默认只给结论字段，配 `--top`/`--verbose` 才带 `top` 排行） |
| `--no-switch` | 只测速不切换 |

`dl` 专属选项：

| 选项 | 说明 |
| --- | --- |
| `-o, --output <文件>` | 下载输出文件名（默认从 URL / Content-Disposition 推断） |
| `-d, --dir <目录>` | 下载保存目录（默认当前目录） |
| `-t, --threads <n>` | 并发线程数（默认 8） |
| `-H, --header <头>` | 自定义 HTTP 头，可多次（非公开 URL 认证用） |
| `--no-proxy` | 直连下载，不走代理、不选节点 |
| `--force-node` | 强制用内置 Node 下载器（不探测 aria2c） |

| 环境变量 | 说明 |
| --- | --- |
| `CLASH_API` | 覆盖端点，如 `http://127.0.0.1:9097`（默认命名管道 / Unix socket） |
| `CLASH_SOCK` | 覆盖 Unix socket 路径（macOS/Linux） |
| `CLASH_PIPE` | 覆盖 Windows 命名管道路径 |
| `CLASH_SECRET` | HTTP 模式下的 secret（socket/pipe 传输无需 secret） |
| `CLASH_MIXED_PORT` | 下载命令提示的代理端口（默认 7897） |

## 多线程下载引擎

下载引擎独立可用，与选节点解耦：

- **`clash-dl <url>`** — 独立多线程下载命令：先用 `clash-proxy pick/add` 选好节点，再随时下载。
- **`clash-proxy dl <url>`** — 一键把「选节点 + 下载」合并成一步。

两者共用同一引擎，效果相同。引擎采用**混合三层**（逐级回退）：

| 引擎 | 触发条件 | 能力 |
| --- | --- | --- |
| **aria2 JSON-RPC**（主路径） | aria2c 可用（安装脚本已自动装） | 多连接分片、断点续传、走代理；JSON-RPC 结构化进度、精确错误分类（超时 / 404 / 磁盘满 / 认证失败） |
| **aria2c legacy spawn**（回退） | RPC 实例起不来 | 一次性 spawn aria2c（只拿退出码） |
| **内置 Node 下载器**（兜底） | 未装 aria2c（零依赖） | HTTP Range 分片并发下载，断点续传；不支持 Range 时自动降级单线程 |

- **断点续传**：中断后重跑同 URL 同目录，未完成分片自动续传，已完整文件跳过。
- **Clash 离线兜底**：检测不到 Clash 时自动改直连，不报错卡住；`--no-proxy` 可强制直连。
- **非公开 URL**：`-H` 透传认证头；一次性签名 / 受限 URL 遇 401/403/429 自动降级单线程，避免整体失败。

> aria2c 通常无需手动安装；若自动安装失败可手动：Windows `winget install aria2.aria2`、macOS `brew install aria2`、Linux `sudo apt install aria2`（Debian/Ubuntu）或 `sudo dnf install aria2`（Fedora）。

## 特性

- **零配置**：走 Verge 命名管道 / Unix socket，免开 external controller、免 secret
- **零 npm 依赖**：纯 Node + vendored js-yaml，无需 `npm install`
- **针对 URL 精确测速**，而非固定测试站
- **并发测速**（默认 12 路），全节点秒出结果
- **自动建组**：`add` 全自动写增强文件 + reload（走 Verge 命令桥）
- **`dl` 一体化多线程下载**：选节点 + 下载一步完成
- **`--json`** 结构化输出，天然适配 agent 工具调用
- **幂等安装脚本**：重复运行只更新不产生重复 PATH 条目

## 平台支持

| 平台 | 连接 mihomo | 安装 |
| --- | --- | --- |
| Windows | 命名管道 `\\.\pipe\verge-mihomo`（免配置） | `install.ps1` |
| macOS | Unix socket `/tmp/verge/verge-mihomo.sock`（免配置） | `install.sh` |
| Linux | Unix socket `/tmp/verge/verge-mihomo.sock`（免配置） | `install.sh` |

自动检测平台选 IPC 方式；也可用 `CLASH_API` 指向任意 mihomo HTTP external-controller。

## 部署 Agent Skill

把两个 **Agent Skill** 部署到本机**所有已装的 AI agent 工具**（Claude Code / CodeBuddy / WorkBuddy / Gemini / Codex / OpenCode / Hermes / OpenClaw / Grok）：

- `clash-proxy` — 工具使用说明（下载/选节点）
- `clash-proxy-fix` — 安装与排障修复

```powershell
# Windows: powershell · macOS/Linux 需 pwsh（brew install powershell）
powershell -ExecutionPolicy Bypass -File deploy-agents.ps1
# 只装到指定 agent（如 Claude Code）：
powershell -ExecutionPolicy Bypass -File deploy-agents.ps1 -Agent claude
```

装好后对应 agent 在「下载 / 选节点 / 走代理」场景下会**自主调用** clash-proxy，无需手动敲命令。

## 开发

零 npm 依赖的 Node 脚本，无需构建：

```bash
git clone https://github.com/likangdi-code/clash-verge-url-proxy-cli
cd clash-verge-url-proxy-cli
node clash-proxy.mjs list        # 直接运行
```

## 致谢

- [clash-verge-url-proxy](https://github.com/likangdi-code/clash-verge-url-proxy) — 「网址代理」功能、组/规则机制与命令桥
- [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) — Clash Verge Rev 项目
- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) — mihomo 内核与 external-controller API

## License

[GPL-3.0](LICENSE)
