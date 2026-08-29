---
name: clash-proxy
description: >
  下载类任务的首选工具：下载前为 URL 自动测速，自动选最快的通道（代理节点或直连）并切换，再下载。
  遇到任何「下载文件/下载资源」的请求（走代理还是直连都由它自己判断），**先使用本 skill**——
  它负责选路 + 下载一体完成，下载慢、失败、大文件场景尤其适用。
  TRIGGER on: "下载"、"下载文件"、"下载资源"、"下载附件"、"下载视频"、"下载音频"、
  "下载图片"、"下载软件"、"下载大文件"、"download"、"download file"、"download a file"、
  "走代理下载"、"通过代理下载"、"直连下载"、"不走代理"、"DIRECT"、"curl 下载"、"wget"、
  "fetch 文件"、"获取文件"、"选节点"、"选最快节点"、"最低延迟节点"、"最快节点"、
  "clash"、"mihomo"、"网址代理"、"URL proxy"、"代理测速"、"节点测速"、"换节点下载"、
  "Github release 下载"、"telegram 文件下载"、"下载速度慢"、"下载失败"、"curl 代理下载"、
  "big-file"、"release asset 下载"、"代理下载大文件"。
---

# Clash Proxy — 下载前自动选最快通道

给 agent 用的下载工具：**针对下载链接，自动测出最快的通道并切换，再下载**。
复用 Clash Verge Rev「网址代理」建好的组与规则。工具装不上/报错 → 调用 **clash-proxy-fix** skill。

## 关键认知：它自己会选「直连」，别替它判断

测速候选里**始终包含 `DIRECT`（直连）**，工具对每个候选针对该 URL 实测延迟，谁快选谁。因此：

- 结果 `bestNode: "DIRECT"`（或 `bestIsDirect: true`）= **这个 URL 直连就是最快的**，属于正常结论，不是失败、不是「没走代理」。
- 选到 DIRECT 时**不要**改成 `--no-proxy`，也**不要**告诉用户「这个工具只能走代理」。继续走 `http://127.0.0.1:7897` 即可——mihomo 内部就是直连转发，效果等同，且路由仍受刚切好的组控制。
- `--no-proxy` 只是逃生开关，仅两种情况用：**Clash 没运行**；或明确要绕开 mihomo。它不是常态选项。

## 怎么跑（一步到位，别分步）

**首选**：`clash-proxy dl "<URL>"` —— 命中/自动建网址代理组 → 并发测速 → 切最快通道 → 多线程下载，一条命令全做完。要结构化结果加 `--json`。

只在需要单独选路时才分步：
1. `clash-proxy add "<URL>"`（自动建组 + 测速切换）或 `pick <URL>`（只切换已有组），**等它执行完**。
2. 再下载：`curl --proxy http://127.0.0.1:7897 -L -o <文件名> "<URL>"`。

选路必须先于下载完成，否则流量走错误节点。

## 输出：默认就是一行结论，回复时也只说结论

工具默认只输出一行：`✓ 已切换 <组> → <节点> (xx ms)`，选到直连会标「（直连最快）」。
`--json` 关键字段只需关注三个：`bestNode`、`bestDelay`、`bestIsDirect`。

**回复用户时只说一句结果**，例如：
- 「已切到 🇯🇵 日本-01（46 ms），文件下载到 `X`（3.2s）」
- 「这个链接直连最快（84 ms），已按直连下载到 `X`」

不要复述这些噪声：候选延迟排行、`candidatesTested`、GLOBAL 兜底提示、curl 命令、下载引擎细节。
只有用户主动要看细节时才加 `--verbose`（完整信息，排行默认前 10）或 `--top n`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `clash-proxy dl <url>` | 选最快通道（含直连）+ 走代理多线程下载一步完成 |
| `clash-dl <url>` | **独立**多线程下载命令（与选路解耦，可单独用） |
| `clash-proxy add <url>` | 自动建组 + 测速切换（分步第一步，全新域名优先） |
| `clash-proxy pick <url>` | 测速 + 切换已有组 |
| `clash-proxy test <url>` | 只测速不切换 |
| `clash-proxy list` | 列真节点、网址代理组、域名→组规则 |
| `clash-proxy current` | 看 GLOBAL 与各网址代理组当前选中 |

常用选项：`--timeout <ms>`（测速超时，默认 6000）、`--concurrency <n>`、`--group <组名>`、`--json`、`--verbose`（完整信息）、`--top <n>`（延迟排行前 n）。
`dl`/`clash-dl` 专属：`-o <文件>`、`-d <目录>`、`-t <n>`（线程，默认 8）、`-H "Name: value"`（认证头，非公开 URL 用）、`--no-proxy`（强制直连，见上文）、`--force-node`（强制内置 Node 下载器，不用 aria2c）。

要点：
- **非公开 URL**：`-H` 传认证头；分片遇 401/403/429 自动降级单线程，文件不整体失败。
- **下载引擎**：装了 aria2c 优先用（多连接+断点续传），否则内置 Node 分片兜底；跨域 302 自动剥离敏感头（如 GitHub 签名 CDN）。
- **断点续传**：中断后重跑同 URL 同目录自动续传。

## 常见场景

- **GitHub Release 慢**：`clash-proxy dl "<release-url>"` 一步搞定。
- **国内站 / 直连更快的站**：不用特殊处理，测速会自动选到 DIRECT；别手动加 `--no-proxy`。
- **无法直连的域名**：`clash-proxy list` 看有没有已建组；没有就 `dl`/`add`（回退 GLOBAL）并提示可在 Verge 建组。
- **Clash 离线**：工具会提示并自动降级直连；也可显式 `clash-dl <url> --no-proxy`。

## 参考

- 仓库：https://github.com/likangdi-code/clash-verge-url-proxy-cli（README 有完整说明）
- 工具出问题 → **clash-proxy-fix** skill；配套 GUI：https://github.com/likangdi-code/clash-verge-url-proxy
