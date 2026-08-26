---
name: clash-proxy
description: >
  下载类任务的首选工具：下载前为 URL 自动选最低延迟代理节点并切换，再用代理下载。
  遇到任何「下载文件/下载资源」的请求（无论直连还是走代理），**先使用本 skill**——
  它负责选节点 + 下载一体完成，下载慢、失败、大文件场景尤其适用。
  TRIGGER on: "下载"、"下载文件"、"下载资源"、"下载附件"、"下载视频"、"下载音频"、
  "下载图片"、"下载软件"、"下载大文件"、"download"、"download file"、"download a file"、
  "走代理下载"、"通过代理下载"、"curl 下载"、"wget"、"fetch 文件"、"获取文件"、
  "选节点"、"选最快节点"、"最低延迟节点"、"最快节点"、"clash"、"mihomo"、"网址代理"、
  "URL proxy"、"代理测速"、"节点测速"、"换节点下载"、"Github release 下载"、
  "telegram 文件下载"、"下载速度慢"、"下载失败"、"curl 代理下载"、"big-file"、
  "release asset 下载"、"代理下载大文件"。
---

# Clash Proxy — 下载前为 URL 选最低延迟节点

给 agent 用的下载工具：**针对下载链接，自动测出延迟最低的代理节点并切换，再用代理下载**。
复用 Clash Verge Rev「网址代理」建好的组与规则。工具装不上/报错 → 调用 **clash-proxy-fix** skill。

## 前置条件

1. Node.js ≥18。
2. Clash Verge Rev 运行中（本机 mihomo，命名管道 `\\.\pipe\verge-mihomo`）。
3. `clash-proxy` 命令可用。没有 → 用 clash-proxy-fix skill 安装。

## 先判断 Clash 是否在运行

跑 `clash-proxy list`：
- 正常输出「内核 / 真节点 / 网址代理组」→ clash 在线，继续。
- 输出 `⚠️ 未检测到 Clash 在运行` → **跳过测速**：让用户启动 Clash Verge Rev；或 `clash-dl <url> --no-proxy` 直连下载（失败再回头选节点）。

## 使用：先选节点，后下载（强制顺序）

**首选一步**：`clash-proxy dl "<URL>" --json` —— 内部先建组/复用组 + 测速切节点，全部完成才下载，天然满足顺序。

分步（add/pick + curl）：
1. 先 `clash-proxy add "<URL>" --json`（全自动：建组+测速切换；已建组则复用）或 `pick`（只测速切换已有组），**等它执行完**。
2. 确认结果 `switched: true` / `bestNode` 非空（退出码 0）。选节点**必须**先于下载完成，否则流量走错误节点。
3. 再下载：`curl --proxy http://127.0.0.1:7897 -L -o <文件名> "<URL>"`，或 `clash-proxy dl "<URL>"`。

`--json` 关键字段：`switched`（已切换）、`bestNode`（最优节点）、`group`、`isUrlProxy`（true=命中网址代理组精准路由；false=只切了 GLOBAL，仅未匹配规则的流量走它）。

## 常用命令

| 命令 | 说明 |
|---|---|
| `clash-proxy dl <url>` | 选节点 + 走代理多线程下载一步完成 |
| `clash-dl <url>` | **独立**多线程下载命令（与选节点解耦，可单独用） |
| `clash-proxy add <url>` | 自动建组 + 测速切换（分步第一步，全新域名优先） |
| `clash-proxy pick <url>` | 测速 + 切换已有组 |
| `clash-proxy test <url>` | 只测速不切换 |
| `clash-proxy list` | 列真节点、网址代理组、域名→组规则 |
| `clash-proxy current` | 看 GLOBAL 与各网址代理组当前选中 |

常用选项：`--timeout <ms>`（测速超时，默认 6000）、`--concurrency <n>`、`--group <组名>`、`--json`。
`dl`/`clash-dl` 专属：`-o <文件>`、`-d <目录>`、`-t <n>`（线程，默认 8）、`-H "Name: value"`（认证头，非公开 URL 用）、`--no-proxy`（直连）、`--force-node`（强制内置 Node 下载器，不用 aria2c）。

要点：
- **非公开 URL**：`-H` 传认证头；分片遇 401/403/429 自动降级单线程，文件不整体失败。
- **下载引擎**：aria2c 优先（安装器已自动安装；JSON-RPC 控制，`--json` 也能拿准确进度与精确错误分类），无则内置 Node 分片兜底；跨域 302 自动剥离敏感头（如 GitHub 签名 CDN）。
- **断点续传**：中断后重跑同 URL 同目录自动续传。

## 常见场景

- **GitHub Release 慢**：`clash-proxy dl "<release-url>"` 一步搞定。
- **无法直连的域名**：`clash-proxy list` 看有没有已建组；没有就 `dl`/`pick`（回退 GLOBAL）并提示可在 Verge 建组。
- **Clash 离线**：`clash-dl <url> --no-proxy` 直连多线程下载。

## 参考

- 仓库：https://github.com/likangdi-code/clash-verge-url-proxy-cli（README 有完整说明）
- 工具出问题 → **clash-proxy-fix** skill；配套 GUI：https://github.com/likangdi-code/clash-verge-url-proxy
