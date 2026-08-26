#!/usr/bin/env node
/**
 * downloader.mjs — 走代理的多线程下载引擎（clash-proxy dl 用）
 *
 * 混合引擎（三层，逐级回退）：
 *   1. aria2 JSON-RPC（主路径）：启动专属 aria2 RPC 实例（随机端口 + secret），
 *      aria2.addUri 提交下载、轮询 aria2.tellStatus 拿结构化状态——
 *      status/completedLength/totalLength/downloadSpeed/errorCode/errorMessage，
 *      进度字节级上报（--json 模式也准确），错误精确分类（超时/404/磁盘满/认证失败）；
 *      --stop-with-process 绑定本进程，node 退出 aria2 自动退出，不留孤儿；
 *      Ctrl+C 中断后 .aria2 控制文件保留，下次自动续传。
 *   2. legacy spawn（回退）：RPC 实例起不来时一次性 spawn aria2c（只拿退出码）。
 *   3. 内置纯 Node 零依赖下载器（兜底）：没装 aria2c 时用（基于内置 fetch / undici）。
 *      aria2c 由 install.ps1 / install.sh 主动安装（Windows 官方二进制 → bin/；
 *      macOS/Linux 走包管理器），正常情况下主路径 1 常备。
 *
 * 关键设计：用 Node 内置 fetch 预解析重定向链（redirect:follow 自动跨域剥离
 * Authorization/Cookie），解决 aria2c 的硬伤——aria2c 会把 --header 原样带到
 * 重定向后的 CDN 域名导致 401。预解析拿到最终签名 URL 后再交给 aria2，缺陷绕开。
 * 零 npm 依赖：fetch / undici 是 Node 18.17+ 内置。
 *
 * 非公开 URL（需认证）支持：
 *   - --header "Name: value" 可多次指定（如 Authorization / Cookie）
 *   - fetch 预解析自动处理「认证 URL 跨域 302 → 签名 CDN」的敏感头剥离
 *   - probe 遇 401/403 时给出「用 --header 指定认证头」的清晰提示
 *
 * 用法（一般由 clash-proxy.mjs dl 调用，也可独立使用）：
 *   node downloader.mjs <url> [--proxy-port 7897] [--threads 8] [-o 文件名] [-d 目录]
 *   node downloader.mjs <url> --header "Authorization: Bearer <token>" --header "Cookie: a=b"
 *
 * 返回：Promise<{ok, engine, filePath, bytes, threads, durationMs, error?, errorCode?}>
 *       engine: 'aria2c-rpc'（主路径）| 'aria2c'（legacy 回退）| 'node'（兜底）
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ─── aria2c 探测 ─────────────────────────────────────────────────────────────

/** 脚本所在目录（install 脚本把 aria2c 装到同目录 bin/ 下） */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

// Windows 注册表 PATH 兜底：进程的 process.env.PATH 是「改注册表之前」启动的旧快照，
// 可能不含新装的目录（如 aria2）。这里用 reg query 直接读注册表，把新目录并进扫描列表。
// 零依赖：spawnSync + TextDecoder（Node 内置 ICU，可解 GBK/OEM 编码）。
const REG_PATH_KEYS = [
  'HKCU\\Environment', // 用户 PATH
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', // 系统 PATH
]

/** 解码 reg.exe 输出：可能为 UTF-8 / GBK（中文 Windows 的 OEM 码页）/ UTF-16LE */
function decodeReg(buf) {
  if (!buf || buf.length === 0) return ''
  // UTF-16LE：带 BOM 或偶数位置大量空字节
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  let oddNull = 0
  let evenNull = 0
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0) evenNull++
    if (buf[i + 1] === 0) oddNull++
  }
  if (oddNull > evenNull) return buf.toString('utf16le')
  // 先按 UTF-8 解；出现 U+FFFD 替换符说明是 GBK/OEM（中文 Windows 的 reg 常见）→ 用 GBK 兜底
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8 // ICU 无 gbk（极少见）时退回，个别中文目录可能乱码，但不影响存在性判断
  }
}

/** 读注册表 PATH 值 → 目录列表（展开 %VAR% 后按 path.delimiter 切分）；reg 失败静默跳过 */
function readRegistryPathDirs() {
  const dirs = []
  for (const hive of REG_PATH_KEYS) {
    try {
      const r = spawnSync('reg', ['query', hive, '/v', 'Path'], { encoding: 'buffer', windowsHide: true, timeout: 5000 })
      if (r.error || r.status !== 0) continue // reg 不存在 / 权限不足 / 无该值 → 静默跳过
      // reg 输出形如：\r\nHKEY_...\r\n    Path    REG_(EXPAND_)?SZ    <值>\r\n\r\n
      const m = decodeReg(r.stdout).match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im)
      if (!m) continue
      // 展开 %VAR%：SystemRoot / LOCALAPPDATA 等系统级变量在进程 env 快照里都有；缺失则保留原样
      const value = m[1].replace(/%([^%]+)%/g, (orig, name) => process.env[name] ?? orig)
      for (const d of value.split(path.delimiter)) {
        const dir = d.trim()
        if (dir) dirs.push(dir)
      }
    } catch { /* 任何异常静默跳过，不阻断探测 */ }
  }
  return dirs
}

/**
 * 找 aria2c：安装目录 bin/（install 脚本主动安装的位置，优先）→ PATH（含注册表 PATH 兜底）。
 * 只认官方二进制（Windows 的 aria2c.exe / Unix 的 aria2c），不再探测
 * .cmd/.bat 第三方 shim——那些 shim 需要走 cmd shell 转义，是高危 bug 源
 * （cmd 下 \" 不是转义引号，含 &/%/! 的 URL/认证头会被破坏），已随
 * shell:true 路径一并移除。
 */
export function findAria2c() {
  const names = process.platform === 'win32' ? ['aria2c.exe'] : ['aria2c']
  // 1. 安装目录 bin/（脚本同目录，install 主动装的位置）
  for (const n of names) {
    try {
      const p = path.join(SCRIPT_DIR, 'bin', n)
      if (fs.existsSync(p)) return p
    } catch { /* 路径非法跳过 */ }
  }
  // 2. 进程 PATH 快照
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  // 3. Windows 注册表 PATH 兜底（进程 PATH 是旧快照、不含新装目录时）
  if (process.platform === 'win32') pathDirs.push(...readRegistryPathDirs())
  for (const dir of pathDirs) {
    for (const n of names) {
      try {
        const p = path.join(dir, n)
        if (fs.existsSync(p)) return p
      } catch { /* 路径非法跳过 */ }
    }
  }
  return null
}

// ─── aria2 JSON-RPC 引擎（主路径）──────────────────────────────────────────
//
// 启动一个专属 aria2 RPC 实例（--enable-rpc --rpc-secret 随机），通过
// aria2.addUri 提交下载、轮询 aria2.tellStatus 拿结构化状态：
// status / completedLength / totalLength / downloadSpeed / errorCode /
// errorMessage。相比一次性 spawn 只拿退出码，这里能精确分类错误
//（超时 / 404 / 磁盘满 / 认证失败），进度可字节级上报（--json 模式也准确）。
// --stop-with-process=<node pid>：node 退出时 aria2 自动退出，不留孤儿进程；
// Ctrl+C 中断后 .aria2 控制文件保留，continue=true 下次自动续传。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 对本机 aria2 RPC 端点发 JSON-RPC POST，返回 {status, json} */
function rpcPost(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/jsonrpc', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (buf += d))
        res.on('end', () => {
          let json = null
          try { json = JSON.parse(buf) } catch {}
          resolve({ status: res.statusCode, json })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('aria2 RPC 请求超时')))
    req.end(data)
  })
}

/** 调用 aria2 RPC 方法（token 鉴权），json.error 时抛错 */
async function rpcCall(port, secret, method, params) {
  const { json } = await rpcPost(port, { jsonrpc: '2.0', id: 'clash-proxy', method, params: [`token:${secret}`, ...params] })
  if (!json || json.error) throw new Error(`aria2 RPC ${method} 失败: ${json?.error?.message ?? '无响应'}`)
  return json.result
}

/** 启动专属 aria2 RPC 实例并等待就绪（随机端口，最多重试 3 次；失败返回 null） */
async function startAria2Rpc(ariaPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const secret = randomBytes(12).toString('hex')
    let exited = false
    let child
    try {
      child = spawn(ariaPath, [
        '--enable-rpc', `--rpc-listen-port=${port}`, `--rpc-secret=${secret}`,
        '--rpc-listen-all=false', '--quiet=true',
        `--stop-with-process=${process.pid}`, // node 退出 → aria2 自动退出（防孤儿进程）
        '--auto-save-interval=10',            // 10s 存一次控制文件（中断后可续传）
        '--continue=true',
      ], { stdio: 'ignore', shell: false })
    } catch { return null }
    child.on('error', () => { exited = true })
    child.on('close', () => { exited = true })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !exited) {
      try {
        await rpcCall(port, secret, 'aria2.getVersion', [])
        return { child, port, secret }
      } catch { await sleep(150) }
    }
    try { child.kill() } catch {}
  }
  return null
}

/** 速度格式化（bytes/s → 人类可读） */
function formatBps(n) {
  return n && n > 0 ? formatBytes(n) + '/s' : '--'
}

/**
 * aria2 JSON-RPC 下载（主路径）。
 * 返回 null = RPC 实例启动失败（调用方回退 legacy spawn）；
 * 下载中途 RPC 失联则如实返回 {ok:false}（错误信息可诊断）。
 */
async function runAria2cRpc(url, { proxyPort, threads, output, dir, ariaPath, headers, onProgress }) {
  const rpc = await startAria2Rpc(ariaPath)
  if (!rpc) return null
  const { child, port, secret } = rpc
  const started = Date.now()
  // 归一化输出路径：-o 绝对路径 → 拆成 dir + out（aria2c 的 -o 只接受文件名）
  const outDir = output && path.isAbsolute(output) ? path.dirname(output) : (dir ?? '.')
  const outFile = output ? path.basename(output) : guessFilename(url, null)
  const t = Math.max(1, Math.min(threads, 16)) // aria2 上限：max-connection-per-server ≤ 16
  const options = {
    dir: path.resolve(outDir),
    out: outFile,
    continue: 'true',
    'max-connection-per-server': String(t),
    split: String(t),
    'min-split-size': '1M',
    'allow-overwrite': 'true',
    'auto-file-renaming': 'false',
    'max-tries': '5',
    'retry-wait': '2',
  }
  if (proxyPort) options['all-proxy'] = `http://127.0.0.1:${proxyPort}`
  else options['no-proxy'] = '*'
  if (headers) options.header = Object.entries(headers).map(([k, v]) => `${k}: ${v}`)
  let gid = null
  try {
    gid = await rpcCall(port, secret, 'aria2.addUri', [[url], options])
    let rpcFailures = 0
    for (;;) {
      await sleep(500)
      let st
      try {
        st = await rpcCall(port, secret, 'aria2.tellStatus', [gid])
        rpcFailures = 0
      } catch (e) {
        // RPC 失联（aria2 崩了）：连续 3 次才判定失败，避免瞬时抖动误杀
        if (++rpcFailures >= 3) return { ok: false, engine: 'aria2c-rpc', filePath: path.join(outDir, outFile), error: `aria2 RPC 连接中断: ${e.message}`, threads: t, durationMs: Date.now() - started }
        continue
      }
      const doneBytes = Number(st.completedLength ?? 0)
      const total = Number(st.totalLength ?? 0)
      onProgress?.({
        doneBytes,
        total: total > 0 ? total : null,
        threads: t,
        speed: formatBps(Number(st.downloadSpeed ?? 0)),
        filename: outFile,
      })
      if (st.status === 'complete') {
        return { ok: true, engine: 'aria2c-rpc', filePath: st.files?.[0]?.path ?? path.join(outDir, outFile), bytes: total, threads: t, durationMs: Date.now() - started }
      }
      if (st.status === 'error' || st.status === 'removed') {
        return { ok: false, engine: 'aria2c-rpc', filePath: st.files?.[0]?.path ?? null, error: st.errorMessage ?? `aria2 状态 ${st.status}`, errorCode: st.errorCode ?? null, threads: t, durationMs: Date.now() - started }
      }
    }
  } finally {
    if (gid) { try { await rpcCall(port, secret, 'aria2.removeDownloadResult', [gid]) } catch {} }
    try { child.kill() } catch {}
  }
}

/** 用 aria2c 下载（legacy 回退：RPC 实例起不来时才用；只拿退出码，无结构化状态） */
function runAria2cLegacy(url, { proxyPort, threads, output, dir, ariaPath, headers, jsonMode }) {
  return new Promise((resolve) => {
    const args = [
      '--auto-file-renaming=false',
      '--allow-overwrite=true',
      '--summary-interval=1',
      '-x', String(threads),
      '-s', String(threads),
      '-k', '1M',
      '-c', // 断点续传
    ]
    if (proxyPort) args.push('--all-proxy', `http://127.0.0.1:${proxyPort}`)
    else args.push('--no-proxy', '*')
    for (const [k, v] of Object.entries(headers ?? {})) args.push(`--header=${k}: ${v}`)
    // -o 只接受文件名：绝对路径拆成 -d + -o（与 RPC 引擎、Node 引擎语义一致）
    if (output) {
      if (path.isAbsolute(output)) args.push('-d', path.dirname(output), '-o', path.basename(output))
      else args.push('-o', output)
    }
    if (dir) args.push('-d', dir)
    args.push(url)
    // json 模式下静默（aria2c 进度输出会污染 stdout 的 JSON）；非 json 继承 stdio 展示进度
    const stdio = jsonMode ? 'ignore' : 'inherit'
    const child = spawn(ariaPath ?? 'aria2c', args, { stdio, shell: false })
    child.on('error', (e) => resolve({ ok: false, engine: 'aria2c', error: e.message }))
    child.on('close', (code) => {
      resolve({ ok: code === 0, engine: 'aria2c', filePath: output ? path.join(output && path.isAbsolute(output) ? path.dirname(output) : (dir ?? '.'), path.basename(output)) : null, exitCode: code })
    })
  })
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function formatBytes(n) {
  if (n == null || isNaN(n)) return '?'
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GiB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MiB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + ' KiB'
  return n + ' B'
}

function formatSpeed(bytes, ms) {
  if (ms <= 0) return '?'
  return formatBytes((bytes / ms) * 1000) + '/s'
}

/** 从 URL / Content-Disposition 推断文件名（净化：仅取 basename，防路径穿越） */
function guessFilename(urlStr, disposition) {
  let name = null
  if (disposition) {
    const utf8 = disposition.match(/filename\*=(?:UTF-8'')?["']?([^"';]+)["']?/i)
    if (utf8) name = decodeURIComponent(utf8[1])
    else {
      const plain = disposition.match(/filename=["']?([^"';]+)["']?/i)
      if (plain) name = plain[1]
    }
  }
  if (name == null) {
    const u = new URL(urlStr)
    const base = path.basename(u.pathname)
    if (base && base !== '/' && base !== '\\') name = decodeURIComponent(base)
  }
  if (name == null) name = `download-${Date.now()}`
  // 净化：去掉路径分隔符和危险字符，仅保留文件名
  return path.basename(name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'))
}

// ─── 连接类错误码（供 clash-proxy.mjs 导入判断降级）──────────────────────────

export const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])

// ─── 代理配置：Node 内置 fetch 通过 HTTPS_PROXY/HTTP_PROXY 环境变量走代理 ────
//
// undici 的 fetch 读取 HTTPS_PROXY / HTTP_PROXY / NO_PROXY 环境变量（Node 18+ 内置支持）。
// 需要走代理时在调用前设置这些变量；NO_PROXY 保护本地直连。此函数幂等（不覆盖用户已有值）。

function ensureProxyEnv(proxyPort) {
  if (!proxyPort) return
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`
  }
  if (!process.env.HTTP_PROXY && !process.env.http_proxy) {
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`
  }
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || ''
  if (!noProxy.split(',').map((s) => s.trim()).includes('127.0.0.1')) {
    process.env.NO_PROXY = [noProxy, '127.0.0.1,localhost'].filter(Boolean).join(',')
  }
}

// ─── 预解析：fetch 跟随重定向 + 自动跨域剥离敏感头 ──────────────────────────
//
// 用 GET + Range: bytes=0-0 探测，同时拿 Content-Length / Accept-Ranges / 文件名 /
// 处理重定向。fetch 的 redirect:'follow' 在跨域跳转时自动剥离 Authorization/Cookie
// （Node 内置 undici，CVE-2023-45143 已修复）——这正是 aria2c 做不到的关键能力。

/** 跨域重定向后需剥离的敏感头（认证签名只对原域有效） */
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie'])

async function probe(urlStr, proxyPort, headers) {
  ensureProxyEnv(proxyPort)
  const MAX_REDIRECT = 8
  let cur = urlStr
  const h = { ...(headers ?? {}) }
  if (!h['User-Agent']) h['User-Agent'] = 'clash-proxy'
  for (let i = 0; i < MAX_REDIRECT; i++) {
    const res = await fetch(cur, {
      headers: { ...h, Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    const status = res.status
    const finalUrl = res.url || cur
    await res.body?.cancel().catch(() => {})
    // 非公开 URL：401/403 说明缺认证（或签名失效）
    if (status === 401 || status === 403) {
      const authNeeded = !headers || Object.keys(headers).length === 0
      throw new Error(
        `HTTP ${status}（${authNeeded ? '非公开 URL 需要认证，请用 --header "Authorization: Bearer <token>" 等指定认证头' : '认证失败或签名过期，请检查 --header 提供的认证信息'}）`,
      )
    }
    const cr = res.headers.get('content-range') // 'bytes 0-0/12345'
    let total = null
    if (cr) {
      const m = cr.match(/\/(\d+)$/)
      if (m) total = Number(m[1])
    }
    if (total == null && res.headers.get('content-length')) total = Number(res.headers.get('content-length'))
    // 跨域（host 变化）→ 剥离敏感头供下载阶段复用；同域 → 保留（可能仍需认证）
    let effectiveHeaders = headers
    if (new URL(finalUrl).host !== new URL(urlStr).host) {
      effectiveHeaders = Object.fromEntries(
        Object.entries(headers ?? {}).filter(([k]) => !SENSITIVE_HEADERS.has(k.toLowerCase())),
      )
    }
    return {
      url: finalUrl,
      total,
      acceptsRange: res.headers.get('accept-ranges') === 'bytes' || !!cr,
      disposition: res.headers.get('content-disposition'),
      statusCode: status,
      headers: effectiveHeaders,
    }
  }
  throw new Error('重定向次数过多')
}

/**
 * 内置下载（基于 Node 内置 fetch / undici，零 npm 依赖）
 * @param {string} urlStr 目标 URL
 * @param {{proxyPort:number|null, threads:number, output?:string, dir?:string, onProgress?:Function, headers?:Object}} opts
 */
export async function downloadNode(urlStr, { proxyPort, threads = 4, output, dir = '.', onProgress, headers } = {}) {
  const info = await probe(urlStr, proxyPort, headers)
  if (info.statusCode >= 400) throw new Error(`HTTP ${info.statusCode}（服务器返回错误）`)
  // probe 已处理跨域重定向的敏感头剥离，下载阶段复用剥离后的 headers
  const effHeaders = info.headers ?? headers
  const filename = output ?? guessFilename(info.url, info.disposition)
  // -o 传绝对路径时直接用；相对路径/未指定时拼到 -d 目录（默认当前目录）
  const filePath = filename && path.isAbsolute(filename) ? filename : path.join(dir, filename)
  const started = Date.now()
  await fs.promises.mkdir(dir, { recursive: true })

  const report = (doneBytes, threadsUsed) => {
    if (!onProgress) return
    onProgress({
      doneBytes,
      total: info.total,
      threads: threadsUsed ?? 1,
      speed: formatSpeed(doneBytes, Date.now() - started),
      eta: info.total && doneBytes > 0 ? Math.round(((info.total - doneBytes) / doneBytes) * (Date.now() - started) / 1000) : null,
      filename,
    })
  }

  // 完整文件已存在且大小吻合 → 直接完成（断点续传 / 幂等）
  const existingSize = () => {
    try { return fs.statSync(filePath).size } catch { return 0 }
  }
  if (info.total != null && existingSize() === info.total) {
    return { ok: true, engine: 'node', filePath, bytes: info.total, threads: 1, durationMs: Date.now() - started, resumed: true }
  }

  // 单线程流式下载（fetch 流写入文件）
  const downloadSingle = async () => {
    const res = await fetch(info.url, {
      headers: { ...(effHeaders ?? {}), 'User-Agent': 'clash-proxy' },
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    })
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`)
    if (!res.body) throw new Error('响应无 body')
    const ws = fs.createWriteStream(filePath)
    const reader = res.body.getReader()
    let done = 0
    const pump = async () => {
      while (true) {
        const { value, done: d } = await reader.read()
        if (d) break
        if (value?.length) {
          ws.write(value)
          done += value.length
          report(done, 1)
        }
      }
      ws.end()
    }
    await new Promise((resolvePromise, rejectPromise) => {
      pump().then(resolvePromise, rejectPromise)
      ws.on('error', rejectPromise)
    })
    return { ok: true, engine: 'node', filePath, bytes: done, threads: 1, durationMs: Date.now() - started }
  }

  // 决定模式：不支持 Range / 大小未知 / 太小 → 单线程
  const useMulti = !!info.acceptsRange && info.total != null && info.total >= 256 * 1024
  if (!useMulti) return downloadSingle()

  // ─── 多线程 Range 分片并发（fetch + Range）───
  const total = info.total
  const n = Math.max(1, Math.min(threads, Math.ceil(total / (256 * 1024))))
  const CONCURRENCY = Math.min(n, threads, 8)
  const ranges = []
  for (let i = 0; i < n; i++) {
    const start = Math.floor((total * i) / n)
    const end = Math.floor((total * (i + 1)) / n) - 1
    ranges.push([start, end])
  }
  const partOf = (i) => `${filePath}.part${i}`
  const cleanPath = (p) => {
    try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch {}
  }

  const doneParts = new Array(n).fill(false)
  let doneBytes = 0

  // 断点续传：检查已有 .part 是否完整，完整则跳过
  for (let i = 0; i < n; i++) {
    const p = partOf(i)
    if (fs.existsSync(p)) {
      try {
        const sz = fs.statSync(p).size
        if (sz === ranges[i][1] - ranges[i][0] + 1) { doneParts[i] = true; doneBytes += sz }
        else cleanPath(p) // 不完整分片 → 重下
      } catch { cleanPath(p) }
    }
  }

  const fetchPart = async (start, end) => {
    const res = await fetch(info.url, {
      headers: { ...(effHeaders ?? {}), 'User-Agent': 'clash-proxy', Range: `bytes=${start}-${end}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(60000),
    })
    return res
  }

  const timer = setInterval(() => report(doneBytes, n), 500)
  let errored = null
  let forbidden = false // 401/403/429 → 一次性签名/受限 URL，降级单线程
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      let nextIdx = 0
      let activeCount = 0
      let completed = doneParts.filter(Boolean).length

      const startOne = () => {
        while (activeCount < CONCURRENCY && nextIdx < n) {
          const idx = nextIdx++
          if (doneParts[idx]) continue
          activeCount++
          const [start, end] = ranges[idx]
          const ws = fs.createWriteStream(partOf(idx))
          ws.on('finish', () => {
            doneParts[idx] = true
            doneBytes += end - start + 1
            activeCount--
            completed++
            report(doneBytes, n)
            if (completed === n) resolvePromise()
            else startOne()
          })
          ws.on('error', (e) => { if (!errored) { errored = e; rejectPromise(e) } })
          fetchPart(start, end).then((res) => {
            if ([401, 403, 429].includes(res.status)) { forbidden = true; res.body?.cancel().catch(() => {}); rejectPromise(new Error(`分片 ${idx} HTTP ${res.status}`)); return }
            if (res.status >= 400) throw new Error(`分片 ${idx} HTTP ${res.status}`)
            if (!res.body) throw new Error(`分片 ${idx} 无 body`)
            const reader = res.body.getReader()
            const pump = () => {
              reader.read().then(({ value, done: d }) => {
                if (d) return ws.end()
                if (value?.length) ws.write(value)
                pump()
              }).catch((e) => { if (!errored) { errored = e; rejectPromise(e) } })
            }
            pump()
          }).catch((e) => { if (!errored) { errored = e; rejectPromise(e) } })
        }
        if (activeCount === 0 && completed === n) resolvePromise()
      }
      startOne()
    })
  } catch (e) {
    // 捕获 worker 池异常（await 直接抛出会跳过降级检查），记录后走下方降级判定
    errored = errored ?? e
  } finally {
    clearInterval(timer)
  }

  // 分片因认证/限流失败 → 一次性签名或受限 URL，清理分片后降级单线程完整下载
  if (forbidden || (errored && /HTTP (401|403|429)/.test(errored.message))) {
    for (let i = 0; i < n; i++) cleanPath(partOf(i))
    if (fs.existsSync(filePath)) cleanPath(filePath)
    return downloadSingle()
  }
  if (errored) throw errored

  // 拼接分片 → 最终文件
  await new Promise((resolvePromise, rejectPromise) => {
    const ws = fs.createWriteStream(filePath)
    let i = 0
    const pump = () => {
      if (i >= n) return ws.end()
      const rs = fs.createReadStream(partOf(i))
      rs.on('error', rejectPromise)
      rs.pipe(ws, { end: false })
      rs.on('end', () => { i++; pump() })
    }
    ws.on('finish', resolvePromise)
    ws.on('error', rejectPromise)
    pump()
  })
  for (let i = 0; i < n; i++) cleanPath(partOf(i))

  return { ok: true, engine: 'node', filePath, bytes: total, threads: n, durationMs: Date.now() - started }
}

// ─── 统一入口 ────────────────────────────────────────────────────────────────

/**
 * 下载（混合引擎三层：aria2 JSON-RPC 主路径 → legacy spawn 回退 → 内置 Node 下载器兜底）
 * aria2c 路径：先用 fetch 预解析重定向链（跨域自动剥敏感头），拿到最终签名 URL
 * 后交给 aria2——绕开它「把 --header 带到 CDN」的硬伤；RPC 引擎提供结构化进度与
 * 精确错误分类，RPC 实例起不来时回退一次性 spawn（只拿退出码）。
 * @param {string} urlStr
 * @param {{proxyPort:number|null, threads?:number, output?:string, dir?:string, forceNode?:boolean, headers?:Object, jsonMode?:boolean, onProgress?:Function}} opts
 */
export async function download(urlStr, { proxyPort, threads = 8, output, dir = '.', forceNode = false, headers, jsonMode, onProgress } = {}) {
  const aria = forceNode ? null : findAria2c()
  if (aria) {
    // 用 fetch 预解析：跟随重定向 + 跨域剥离敏感头，拿到最终 URL 与真实文件名。
    // aria2c 收到的头 = probe 剥离后的头（跨域后 Authorization/Cookie 只对原域有效）。
    let finalUrl = urlStr
    let filename = output
    let ariaHeaders = headers
    try {
      const info = await probe(urlStr, proxyPort, headers)
      finalUrl = info.url
      ariaHeaders = info.headers ?? headers
      if (!filename) filename = guessFilename(info.url, info.disposition)
    } catch (e) {
      // 预解析失败（如 401/403 需认证）→ 不降级，直接把错误抛给上层（有清晰提示）
      // 但若只是探测超时/连接等瞬时问题，仍允许 aria2c 直接尝试原始 URL。
      // 注意：AbortSignal.timeout 抛的是 DOMException(TimeoutError, "The operation was
      // aborted due to timeout")——英文 "timeout/aborted" 也必须算瞬时问题，否则探测超时
      // 会把整个下载 abort 掉（即使 aria2c 本可正常下载）。
      if (e instanceof Error && /HTTP 401|HTTP 403/.test(e.message)) throw e
      const transient = e?.name === 'TimeoutError' || /重定向|超时|timeout|socket|connect|aborted/i.test(e?.message ?? '')
      if (!transient) throw e
    }
    // 主路径：JSON-RPC（结构化进度 + 精确错误分类）；RPC 实例起不来再回退一次性 spawn
    const rpcRes = await runAria2cRpc(finalUrl, { proxyPort, threads, output: filename, dir, ariaPath: aria, headers: ariaHeaders, onProgress })
    if (rpcRes) return rpcRes
    return runAria2cLegacy(finalUrl, { proxyPort, threads, output: filename, dir, ariaPath: aria, headers: ariaHeaders, jsonMode })
  }
  ensureProxyEnv(proxyPort)
  return downloadNode(urlStr, { proxyPort, threads, output, dir, headers, onProgress })
}

/** 解析 "Name: value" 字符串为 headers 对象（多个 header 用数组传入） */
export function parseHeaders(list) {
  const headers = {}
  for (const h of list ?? []) {
    const i = h.indexOf(':')
    if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim()
  }
  return headers
}

// ─── CLI 独立入口（node downloader.mjs <url> ...）─────────────────────────────
async function main() {
  const argv = process.argv.slice(2)
  const opts = { proxyPort: Number(process.env.CLASH_MIXED_PORT ?? 7897), threads: 8, output: null, dir: '.', forceNode: false, json: false, headers: null }
  const headerList = []
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--proxy-port') opts.proxyPort = Number(argv[++i])
    else if (a === '--threads' || a === '-t') opts.threads = Number(argv[++i])
    else if (a === '-o') opts.output = argv[++i]
    else if (a === '-d') opts.dir = argv[++i]
    else if (a === '--no-proxy') opts.proxyPort = null
    else if (a === '--force-node') opts.forceNode = true
    else if (a === '--header' || a === '-H') headerList.push(argv[++i])
    else if (a === '--json') opts.json = true
    else if (a.startsWith('-')) { console.error(`未知选项: ${a}`); process.exit(2) }
    else positional.push(a)
  }
  const urlStr = positional[0]
  if (!urlStr) { console.error('用法: node downloader.mjs <url> [--proxy-port 7897] [--threads 8] [-o 文件] [-d 目录] [-H "Authorization: Bearer xxx"] [--no-proxy]'); process.exit(2) }
  if (headerList.length) opts.headers = parseHeaders(headerList)

  let last = null
  // 进度渲染：RPC / Node 引擎统一单行刷新（--json 静默避免污染输出）
  const render = (p) => {
    last = p
    if (opts.json) return
    const pct = p.total ? Math.min(100, Math.round((p.doneBytes / p.total) * 100)) : '?'
    const line = `\r⏬ ${p.filename}  ${pct}%  ${formatBytes(p.doneBytes)}/${p.total ? formatBytes(p.total) : '?'}  ${p.speed ?? '--'}  ${p.threads}线程`
    process.stdout.write(line.padEnd(Math.min(process.stdout.columns ?? 100, 100)))
  }
  const res = await download(urlStr, { ...opts, jsonMode: opts.json, onProgress: render })
  if (!opts.json && res.engine !== 'aria2c') process.stdout.write('\r\x1b[K')
  if (res.ok && !res.filePath && res.engine === 'aria2c') {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, engine: 'aria2c', filePath: null, bytes: null, threads: opts.threads, durationMs: null }))
    } else {
      console.log('✓ aria2c 下载完成（退出码 0）')
    }
    // 用 process.exitCode 而非 process.exit：fetch/undici 的异步 handle 在强制退出时
    // 会触发 libuv 断言（Windows uv async.c）。设 exitCode 后自然退出，让流清理完成。
    return
  }
  if (res.ok) {
    // 平均速度（完成瞬间瞬时速度归零，RPC 引擎用 bytes/duration 更真实）
    const avgSpeed = res.bytes && res.durationMs ? formatBps((res.bytes / res.durationMs) * 1000) : null
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, engine: res.engine, filePath: res.filePath, bytes: res.bytes, threads: res.threads, durationMs: res.durationMs, avgSpeed: avgSpeed ?? (last ? last.speed : null) }))
    } else {
      console.log(`✓ 下载完成  ${res.filePath}  ${formatBytes(res.bytes)}  （${res.engine} ${res.threads} 线程, ${(res.durationMs / 1000).toFixed(1)}s${avgSpeed ? ', ' + avgSpeed : ''}）`)
    }
    return
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, engine: res.engine ?? null, filePath: res.filePath ?? null, error: res.error ?? `退出码 ${res.exitCode}`, errorCode: res.errorCode ?? null }))
  } else {
    console.error(`✗ 下载失败: ${res.error ?? `退出码 ${res.exitCode}`}`)
  }
  process.exitCode = 1
}

// 独立运行入口
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error('downloader 错误:', e.message); process.exitCode = 1 })
}
