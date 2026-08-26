---
name: clash-proxy-fix
description: >
  clash-proxy 工具安装与排障：命令不存在、irm|iex 安装失败、运行报错排查、skill 部署。
  TRIGGER on: "clash-proxy 装不上"、"安装失败"、"Missing expression"、"install.ps1"、
  "BOM"、"clash-proxy 报错"、"clash-proxy 排障"、"重装 clash-proxy"、"修复 clash-proxy"、
  "deploy-agents"、"skill 部署"、"skill 没生效"、"clash-dl 没装"、"下载器坏"。
---

# Clash Proxy 修复与排障

工具本体坏了（命令不存在 / 报错 / 下载异常）或 skill 未部署时用本 skill。正常使用见 **clash-proxy** skill。

## 一、安装与重装

**一键安装/重装**（覆盖更新，幂等）：

```powershell
irm https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.ps1 | iex
```

**若 `irm | iex` 报 `Missing expression after unary operator '-'`**：
- 原因：install.ps1 带 UTF-8 BOM 时，PowerShell 字符串解析不跳过 BOM，文件开头块注释失效（旧版安装脚本的问题，新版已修；CDN 可能有缓存延迟）。
- 解决：等几分钟重试；或两步安装（绕缓存）：

```powershell
irm https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.ps1 -OutFile "$env:TEMP\install.ps1"
iex (Get-Content "$env:TEMP\install.ps1" -Raw -Encoding UTF8)
```

**验证安装**：`clash-proxy list` 正常输出「内核 / 真节点 / 网址代理组」即成功。

## 二、常见报错排障

| 症状 | 原因与处理 |
|---|---|
| `list` 报「无法连接」 | Verge 没在跑/内核没起 → 启动 Clash Verge Rev |
| 测速全部失败「无可用节点」 | 网络不通或超时短 → 加 `--timeout 10000` 重试 |
| `✗ 切换失败（HTTP 400 ... proxy not exist）` | 订阅刷新后节点重命名/移除 → 重新 `clash-proxy pick` |
| 下载走了错误节点 | 域名被订阅其他规则先匹配 → `--group` 指定组，或 Verge「网址代理」页建组 |
| `clash-dl` 命令不存在 | 旧版安装脚本漏装下载器 → 重跑安装脚本（新版会装 downloader.mjs） |
| 非公开 URL 401/403/429 | 缺认证头 → `-H "Authorization: Bearer ..."` / `-H "Cookie: ..."`；分片失败自动降级单线程，不整体失败 |
| 断点续传无效 | 重跑同 URL 同目录才续传；换目录/文件名视为新任务 |
| `dl` 结果 `engine: node`（没用 aria2c） | aria2c 未就绪 → 重跑安装脚本（自动装到安装目录 `bin\aria2c.exe`）；或手动 `winget install aria2.aria2` |
| `--json` 里 `errorCode` 是数字 | aria2 错误码（RPC 引擎精确分类）：1=未知、3=资源不存在(404)、9=超时、13=无法创建文件(磁盘/权限)、18=断点续传被拒、22=HTTP 响应头异常 |

## 三、Skill 部署 / 重部署

安装目录下（`%LOCALAPPDATA%\Programs\clash-proxy\deploy-agents.ps1`）：

```powershell
# 部署 clash-proxy + clash-proxy-fix 两个 skill 到本机所有 agent 工具
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\clash-proxy\deploy-agents.ps1"
# 只装到指定 agent（如 Claude Code）
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\clash-proxy\deploy-agents.ps1" -Agent claude
```

装好后 agent 需**重启会话**（或 `/skills reload`）才能识别新 skill。

skill 文件也可手动下载：
- 使用说明：`https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/skills/clash-proxy/SKILL.md`
- 本修复 skill：`https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/skills/clash-proxy-fix/SKILL.md`

## 四、边界备忘（排障常踩的坑）

- `add` 自动建组（写增强文件 + reload）；`pick` 只对已建组测速切换。全新域名用 `add`。
- 测速**真实节点 + DIRECT**（跳过策略组）；DIRECT 参与：国内内容直连快会自动切 DIRECT。
- `isUrlProxy: false` = 只切了 GLOBAL，仅未匹配规则的流量走它；需精准路由要在 Verge 为该域名建组。
- 下载引擎三层：**aria2 JSON-RPC 主引擎**（专属实例：随机端口 + secret，node 退出自动清理不留孤儿；Ctrl+C 中断后重跑同 URL 同目录自动续传）→ RPC 起不来回退一次性 spawn → 内置 Node 分片兜底。aria2c 由安装脚本自动安装（Windows：安装目录 `bin\aria2c.exe`）；PATH 已有的官方 aria2c 直接复用。
