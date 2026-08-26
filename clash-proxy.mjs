#!/usr/bin/env node
/**
 * clash-proxy — 下载前为 URL 选择最低延迟节点的 CLI 工具
 *
 * 通过 mihomo 的 external-controller（默认走 Clash Verge Rev 的命名管道
 * \\.\pipe\verge-mihomo，免配置；也可用 CLASH_API 指向 HTTP 端口）：
 *   1. 解析目标 URL 的域名
 *   2. 自动探测该域名命中的「网址代理」组（DOMAIN-SUFFIX 规则 → URL-Proxy-* 组）
 *   3. 对该组内所有节点并发测速（针对目标 URL）
 *   4. 切到延迟最低的节点
 *   5. 输出结果（人类可读 / --json 机器可读，供 agent 解析后调用下载器）
 *
 * 用法：
 *   node clash-proxy.mjs <url>                 # 测速 + 自动切最低延迟节点
 *   node clash-proxy.mjs pick <url>            # 同上（显式）
 *   node clash-proxy.mjs add <url>             # 自动建网址代理组 + 测速切换
 *   node clash-proxy.mjs test <url>            # 只测速，不切换
 *   node clash-proxy.mjs dl <url>              # 测速切换后直接走代理多线程下载
 *   node clash-proxy.mjs list                  # 列出节点与网址代理组
 *   node clash-proxy.mjs current               # 查看当前选中
 *
 * 选项：
 *   --group <组名>     指定要切换的组（默认自动探测，无命中则 GLOBAL）
 *   --timeout <ms>     单节点测速超时（默认 5000）
 *   --concurrency <n>  并发测速数（默认 12）
 *   --top <n>          只显示延迟最低的前 n 个
 *   --json             输出 JSON
 *   --no-switch        只测速不切换
 *
 * dl 子命令专属选项：
 *   -o/--output <文件> 下载输出文件名（默认从 URL/Content-Disposition 推断）
 *   -d/--dir <目录>    下载保存目录（默认当前目录）
 *   -t/--threads <n>   并发线程数（默认 8，aria2c 为连接数）
 *   -H/--header <头>   自定义 HTTP 头（可多次，非公开 URL 认证用，如 "Authorization: Bearer xxx"）
 *   --no-proxy         直连下载，不走代理、不选节点
 *   --force-node       强制用内置 Node 下载器（不探测 aria2c）
 *
 * 环境变量：
 *   CLASH_API     覆盖端点，如 http://127.0.0.1:9097（默认命名管道）
 *   CLASH_SECRET  HTTP 模式下的 secret（命名管道无需）
 *
 * 下载走代理：curl --proxy http://127.0.0.1:7897 -L -O <url>
 * 多线程下载：clash-proxy dl <url>（aria2 JSON-RPC 主引擎——安装脚本自动装 aria2c，
 *   结构化进度与错误分类；RPC 起不来回退一次性 spawn；未装 aria2c 用内置 Node 分片兜底）
 */
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { load as yamlLoad, dump as yamlDump } from './vendor/js-yaml.mjs'
import { download as dlDownload, RETRYABLE_CODES, parseHeaders } from './downloader.mjs'

// 跨平台 IPC：Windows 用命名管道，macOS/Linux 用 Clash Verge Rev 的 mihomo Unix socket
// （路径来自 clash-verge-rev src-tauri/src/utils/dirs.rs: ipc_path()）
// 环境变量覆盖对齐生态约定：CLASH_PIPE（Windows pipe）、CLASH_SOCK（Unix socket）
function resolveIpcPath() {
  if (process.platform === 'win32') {
    return process.env.CLASH_PIPE || String.raw`\\.\pipe\verge-mihomo`
  }
  if (process.env.CLASH_SOCK) return process.env.CLASH_SOCK
  const candidates = [
    '/tmp/verge/verge-mihomo.sock',
    `${os.homedir()}/.config/verge/verge-mihomo.sock`,
    `${os.homedir()}/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/verge/verge-mihomo.sock`,
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return candidates[0]
}
const IPC_PATH = resolveIpcPath()
const DEFAULT_MIXED_PORT = 7897

// ─── Verge 命令桥（HTTP 单例服务器）：写增强文件 + 校验 + reload（建网址代理组用）──
// 端口来自 clash-verge-rev src-tauri/src/constants.rs: SINGLETON_SERVER = dev 11233 / release 33331

function findProfilesPath() {
  const appdata = process.env.APPDATA
  const home = os.homedir()
  const candidates = [
    appdata && path.join(appdata, 'io.github.clash-verge-rev.clash-verge-rev.dev', 'profiles.yaml'),
    appdata && path.join(appdata, 'io.github.clash-verge-rev.clash-verge-rev', 'profiles.yaml'),
    path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev', 'profiles.yaml'),
    path.join(home, '.config', 'io.github.clash-verge-rev.clash-verge-rev', 'profiles.yaml'),
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || candidates[0]
}

function getSingletonPort() {
  const p = findProfilesPath()
  return p && p.includes('.dev') ? 11233 : 33331
}

/** 调用 Verge 命令桥（HTTP 单例服务器）；可选 token 用环境变量 CLASH_VERGE_API_TOKEN */
async function bridgeRequest(method, apiPath, body) {
  const base = `http://127.0.0.1:${getSingletonPort()}`
  const token = process.env.CLASH_VERGE_API_TOKEN
  return httpRequest(base, method, apiPath, body, null, token ? { 'X-API-Token': token } : null)
}

// ─── 传输层：命名管道 / HTTP，统一返回 {status, json, body} ──────────────────

async function request(method, path, body) {
  const api = process.env.CLASH_API
  const secret = process.env.CLASH_SECRET
  if (api && !api.startsWith('pipe:')) {
    return httpRequest(api, method, path, body, secret)
  }
  return pipeRequest(method, path, body)
}

function httpRequest(base, method, path, body, secret, extraHeaders) {
  const u = new URL(path, base)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (buf += d))
        res.on('end', () => {
          let json = null
          try { json = JSON.parse(buf) } catch {}
          resolve({ status: res.statusCode, body: buf, json })
        })
      },
    )
    req.on('error', reject)
    if (secret) req.setHeader('Authorization', `Bearer ${secret}`)
    if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) req.setHeader(k, v)
    if (body) req.setHeader('Content-Type', 'application/json')
    req.end(body ?? undefined)
  })
}

function pipeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(IPC_PATH)
    let buf = Buffer.alloc(0)
    let settled = false
    const done = (err, res) => {
      if (settled) return
      settled = true
      sock.destroy()
      err ? reject(err) : resolve(res)
    }
    sock.on('connect', () => {
      const h = [`${method} ${path} HTTP/1.1`, 'Host: localhost', 'Connection: close']
      if (body) {
        h.push('Content-Type: application/json')
        h.push(`Content-Length: ${Buffer.byteLength(body)}`) // PUT 必须带字节长度，否则 mihomo 读不到 body
      }
      sock.write(h.join('\r\n') + '\r\n\r\n' + (body ?? ''))
    })
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]) })
    sock.on('end', () => {
      const sep = buf.indexOf('\r\n\r\n')
      if (sep < 0) return done(new Error('响应缺少 HTTP 头分隔符'))
      const head = buf.subarray(0, sep).toString('utf8')
      let bodyBuf = buf.subarray(sep + 4)
      const m = head.split('\r\n')[0].match(/^HTTP\/1\.[01] (\d+)/)
      if (!m) return done(new Error('无法解析 HTTP 状态行'))
      const status = Number(m[1])
      const headers = {}
      for (const l of head.split('\r\n').slice(1)) {
        const c = l.indexOf(':')
        if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim()
      }
      if (headers['transfer-encoding'] === 'chunked') {
        bodyBuf = decodeChunkedBuffer(bodyBuf)
      }
      const bodyText = bodyBuf.toString('utf8')
      let json = null
      try { json = JSON.parse(bodyText) } catch {}
      done(null, { status, headers, body: bodyText, json })
    })
    sock.on('error', (e) => done(e))
  })
}

/** 按字节解码 chunked（chunk size 是字节数，节点名含 emoji 时字符/字节不一致，必须用 Buffer） */
function decodeChunkedBuffer(buf) {
  const out = []
  let pos = 0
  let guard = 0
  while (pos < buf.length && guard++ < 100000) {
    const nl = buf.indexOf('\r\n', pos)
    if (nl < 0) { out.push(buf.subarray(pos)); break }
    const size = parseInt(buf.subarray(pos, nl).toString('utf8').split(';')[0].trim(), 16)
    if (isNaN(size) || size < 0) { out.push(buf.subarray(pos)); break }
    pos = nl + 2
    if (size === 0) break
    out.push(buf.subarray(pos, pos + size))
    pos = pos + size + 2
  }
  return Buffer.concat(out)
}

// ─── 工具函数 ───────────────────────────────────────────────────────────────

const STRATEGY_TYPES = new Set([
  'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Direct', 'Reject', 'Compatible', 'Pass', 'Unknown',
])
const RESERVED = new Set(['GLOBAL', 'DIRECT', 'REJECT', 'COMPATIBLE', 'PASS', 'DIRECT-REJECT'])
const isUrlProxyName = (n) => String(n).startsWith('URL-Proxy-')

function parseHost(input) {
  const s = String(input).trim()
  const withScheme = /^https?:\/\//i.test(s) ? s : s.endsWith('.onion') ? `http://${s}` : `https://${s}`
  const u = new URL(withScheme)
  return { host: u.hostname.replace(/^www\./, ''), url: withScheme }
}

/** host 是否命中规则的 payload（规则域名自身或其子域，避免误匹配） */
function hostMatches(host, payload) {
  return host === payload || host.endsWith('.' + payload)
}

/** /rules API 的 type 是驼峰枚举（DomainSuffix），不是配置格式的 DOMAIN-SUFFIX */
const DOMAIN_SUFFIX_TYPES = new Set(['DomainSuffix', 'DOMAIN-SUFFIX'])

/** 从 /rules 探测 host 命中的网址代理组；命中多个取最具体的（payload 最长） */
function detectUrlProxyGroup(rules, host) {
  let best = null
  let bestLen = -1
  for (const r of rules ?? []) {
    if (!DOMAIN_SUFFIX_TYPES.has(r.type) || !isUrlProxyName(r.proxy)) continue
    if (hostMatches(host, r.payload) && r.payload.length > bestLen) {
      best = r.proxy
      bestLen = r.payload.length
    }
  }
  return best
}

/**
 * 取 /proxies 中目标组的可选节点（过滤策略组与保留名）
 * 规则：DIRECT 始终放行（直连可能比代理快，尤其国内内容）；其余过滤 RESERVED/
 * 策略组。REJECT/COMPATIBLE/PASS 等仍排除（拒绝/兼容节点测速无意义）。
 */
function groupCandidates(proxies, groupName) {
  const info = proxies[groupName]
  if (!info || !Array.isArray(info.all)) return []
  return info.all.filter((n) => {
    if (n === 'DIRECT') return true // 直连参与测速
    return !RESERVED.has(n) && !isUrlProxyName(n) && !STRATEGY_TYPES.has(proxies[n]?.type)
  })
}

/** 并发池测速：返回 [{name, delay|null, status}] */
async function speedTest(names, url, timeoutMs, concurrency) {
  const results = []
  let i = 0
  const workers = Array.from({ length: Math.min(concurrency, names.length) }, async () => {
    while (i < names.length) {
      const idx = i++
      const name = names[idx]
      const path = `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeoutMs}`
      try {
        const r = await request('GET', path)
        const d = r.json?.delay
        results.push({ name, delay: typeof d === 'number' && d > 0 ? d : null, status: r.status })
      } catch (e) {
        results.push({ name, delay: null, status: 0 })
      }
    }
  })
  await Promise.all(workers)
  return results
}

function pickBest(results) {
  let best = null
  for (const r of results) {
    if (r.delay != null && (best == null || r.delay < best.delay)) best = r
  }
  return best
}

// ─── 主逻辑 ─────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const opts = {
    timeout: 5000, concurrency: 12, group: null, top: null, json: false, noSwitch: false,
    output: null, dir: null, threads: 8, noProxy: false, forceNode: false, headers: null,
  }
  const headerList = []
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--group') opts.group = argv[++i]
    else if (a === '--timeout') opts.timeout = Number(argv[++i])
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i])
    else if (a === '--top') opts.top = Number(argv[++i])
    else if (a === '--json') opts.json = true
    else if (a === '--no-switch') opts.noSwitch = true
    else if (a === '-o' || a === '--output') opts.output = argv[++i]
    else if (a === '-d' || a === '--dir') opts.dir = argv[++i]
    else if (a === '-t' || a === '--threads') opts.threads = Number(argv[++i])
    else if (a === '--no-proxy') opts.noProxy = true
    else if (a === '--force-node') opts.forceNode = true
    else if (a === '-H' || a === '--header') headerList.push(argv[++i])
    else if (a.startsWith('-')) { console.error(`未知选项: ${a}`); process.exit(2) }
    else positional.push(a)
  }
  if (headerList.length) opts.headers = parseHeaders(headerList)

  // 区分「隐式 pick」（clash-proxy <url>）与「显式 pick」（clash-proxy pick <url>）
  const rawCmd = positional[0] ?? ''
  let cmd, argUrl
  if (['pick', 'test', 'add', 'dl', 'download', 'list', 'current'].includes(rawCmd)) {
    cmd = rawCmd === 'download' ? 'dl' : rawCmd
    argUrl = ['test', 'pick', 'add', 'dl'].includes(cmd) ? positional[1] : null
  } else {
    cmd = 'pick' // 第一个位置参数就是 URL
    argUrl = rawCmd
  }

  if (cmd === 'list') return cmdList()
  if (cmd === 'current') return cmdCurrent()
  if (cmd === 'add' && argUrl) return cmdAdd(argUrl, opts)
  if (cmd === 'dl' && argUrl) return cmdDownload(argUrl, opts)
  if ((cmd === 'pick' || cmd === 'test') && argUrl) return cmdPick(argUrl, opts, cmd === 'test')
  if (cmd === 'pick' || cmd === 'test') {
    console.error(`用法: node clash-proxy.mjs ${cmd} <url> [--group 组名] [--timeout ms] [--json]`)
    process.exit(2)
  }
  if (cmd === 'add') {
    console.error('用法: node clash-proxy.mjs add <url> [--timeout ms] [--json]')
    process.exit(2)
  }
  if (cmd === 'dl') {
    console.error('用法: node clash-proxy.mjs dl <url> [-o 文件] [-d 目录] [-t 线程数] [-H "Authorization: Bearer xxx"] [--no-proxy] [--force-node] [--json]')
    process.exit(2)
  }
  console.error(`未知命令: ${cmd}`)
  process.exit(2)
}

async function cmdList() {
  const proxies = (await request('GET', '/proxies')).json?.proxies ?? {}
  const rules = (await request('GET', '/rules')).json?.rules ?? []
  const realNodes = []
  const groups = []
  for (const [name, info] of Object.entries(proxies)) {
    if (Array.isArray(info.all)) groups.push({ name, type: info.type, now: info.now, members: info.all.length })
    else if (!RESERVED.has(name)) realNodes.push(name)
  }
  const urlProxy = groups.filter((g) => isUrlProxyName(g.name))
  const urlProxyRules = rules.filter((r) => DOMAIN_SUFFIX_TYPES.has(r.type) && isUrlProxyName(r.proxy))
  const rows = [
    `内核: ${(await request('GET', '/version')).json?.version ?? '?'}`,
    `真节点: ${realNodes.length} 个`,
    `网址代理组: ${urlProxy.length} 个`,
    ...urlProxy.map((g) => `  ${g.name}  (成员 ${g.members}, 当前 ${g.now})`),
  ]
  if (urlProxyRules.length) {
    rows.push(`URL-Proxy 规则 (域名 -> 组):`)
    for (const r of urlProxyRules) rows.push(`  ${r.payload} -> ${r.proxy}`)
  }
  console.log(rows.join('\n'))
}

async function cmdCurrent() {
  const proxies = (await request('GET', '/proxies')).json?.proxies ?? {}
  for (const name of ['GLOBAL', ...Object.keys(proxies).filter(isUrlProxyName)]) {
    const info = proxies[name]
    if (info?.now) console.log(`${name} -> ${info.now}`)
  }
}

/** 对指定组测速 + 切换最低延迟节点（pick / add 共用） */
async function testAndSwitch(group, host, normalizedUrl, opts, testOnly) {
  const proxies = (await request('GET', '/proxies')).json?.proxies ?? {}
  const candidates = groupCandidates(proxies, group)
  const results = await speedTest(candidates, normalizedUrl, opts.timeout, opts.concurrency)
  const sorted = results.filter((r) => r.delay != null).sort((a, b) => a.delay - b.delay)
  const best = pickBest(results)
  let switched = false
  let switchStatus = null
  if (!testOnly && !opts.noSwitch && best) {
    try {
      const r = await request('PUT', `/proxies/${encodeURIComponent(group)}`, JSON.stringify({ name: best.name }))
      switchStatus = r.status
      switched = r.status >= 200 && r.status < 300
    } catch (e) { switchStatus = e.message }
  }
  return { candidates, sorted, best, switched, switchStatus }
}

/** 为域名创建网址代理组：写 Groups/Rules 增强文件 + 校验 + reload（走 Verge 命令桥） */
async function createUrlProxyGroup(host) {
  const proxies = (await request('GET', '/proxies')).json?.proxies ?? {}
  const nodeNames = Object.keys(proxies).filter(
    (n) => !RESERVED.has(n) && !isUrlProxyName(n) && !STRATEGY_TYPES.has(proxies[n]?.type),
  )
  if (nodeNames.length === 0) { console.error('[add] 无可用节点'); return null }
  const id = randomBytes(4).toString('base64url')
  const groupName = `URL-Proxy-${id}`
  const profilesPath = findProfilesPath()
  if (!profilesPath || !fs.existsSync(profilesPath)) { console.error('[add] 未找到 profiles.yaml'); return null }
  const profiles = yamlLoad(fs.readFileSync(profilesPath, 'utf8'))
  const currentItem = (profiles?.items ?? []).find((it) => it?.uid === profiles?.current)
  const groupsUid = currentItem?.option?.groups
  const rulesUid = currentItem?.option?.rules
  if (!groupsUid || !rulesUid) { console.error('[add] 当前订阅未启用「代理组/规则」增强'); return null }
  const profilesDir = path.join(path.dirname(profilesPath), 'profiles')
  const groupFile = (profiles?.items ?? []).find((it) => it?.uid === groupsUid)?.file
  const rulesFile = (profiles?.items ?? []).find((it) => it?.uid === rulesUid)?.file
  if (!groupFile || !rulesFile) { console.error('[add] 增强文件缺失'); return null }
  const groupsDoc = yamlLoad(fs.readFileSync(path.join(profilesDir, groupFile), 'utf8')) ?? {}
  const rulesDoc = yamlLoad(fs.readFileSync(path.join(profilesDir, rulesFile), 'utf8')) ?? {}
  groupsDoc.append = [...(groupsDoc.append ?? []), { name: groupName, type: 'select', proxies: ['DIRECT', 'REJECT', ...nodeNames] }]
  rulesDoc.append = [...(rulesDoc.append ?? []), `DOMAIN-SUFFIX,${host},${groupName}`]
  // 命令桥保存：先组后规则（先写组→新组无规则引用校验通过；再写规则→引用已存在的组）
  let r = await bridgeRequest('POST', `/commands/profile-save?index=${encodeURIComponent(groupsUid)}`, yamlDump(groupsDoc, { forceQuotes: true }))
  if (r.status !== 200) { console.error('[add] 写 groups 增强失败:', r.status, r.body.slice(0, 300)); return null }
  r = await bridgeRequest('POST', `/commands/profile-save?index=${encodeURIComponent(rulesUid)}`, yamlDump(rulesDoc, { forceQuotes: true }))
  if (r.status !== 200) { console.error('[add] 写 rules 增强失败:', r.status, r.body.slice(0, 300)); return null }
  return groupName
}

/** add：为 URL 自动建网址代理组（已存在则复用）+ 测速切换最低延迟节点 */
async function cmdAdd(url, opts) {
  const { host, url: normalizedUrl } = parseHost(url)
  let group = opts.group
  if (!group) {
    try {
      const rules = (await request('GET', '/rules')).json?.rules ?? []
      group = detectUrlProxyGroup(rules, host)
    } catch { /* 忽略 */ }
  }
  if (!group) {
    group = await createUrlProxyGroup(host)
    if (!group) { console.error('✗ 建组失败（检查 Verge 命令桥 / 当前订阅增强配置）'); process.exit(1) }
    console.log(`✓ 已创建网址代理组 ${group}（${host}）`)
  } else {
    console.log(`✓ 复用已有网址代理组 ${group}`)
  }
  const { candidates, sorted, best, switched } = await testAndSwitch(group, host, normalizedUrl, opts, false)
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, host, url: normalizedUrl, group, isUrlProxy: isUrlProxyName(group), bestNode: best?.name ?? null, bestDelay: best?.delay ?? null, switched, candidatesTested: candidates.length, top: sorted.slice(0, opts.top || 5).map((r) => ({ name: r.name, delay: r.delay })) }))
    return
  }
  console.log(`组: ${group}  测速节点: ${candidates.length} 个`)
  if (best) console.log(`✓ 已切换 ${group} → ${best.name} (${best.delay} ms)`)
  else console.log('⚠ 无可用节点（全部超时/失败）')
  console.log(`下载: curl --proxy http://127.0.0.1:${process.env.CLASH_MIXED_PORT ?? DEFAULT_MIXED_PORT} -L -O '${url}'`)
}

async function cmdPick(url, opts, testOnly) {
  const { host, url: normalizedUrl } = parseHost(url)
  let group = opts.group
  if (!group) {
    try {
      const rules = (await request('GET', '/rules')).json?.rules ?? []
      group = detectUrlProxyGroup(rules, host)
    } catch { /* 忽略，回退 GLOBAL */ }
  }
  if (!group) group = 'GLOBAL'
  const { candidates, sorted, best, switched, switchStatus } = await testAndSwitch(group, host, normalizedUrl, opts, testOnly)
  if (candidates.length === 0) {
    const msg = `组 ${group} 无可测节点（${host}）`
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg, host }))
    else console.error(msg)
    process.exit(1)
  }
  const display = opts.top ? sorted.slice(0, opts.top) : sorted
  const result = {
    ok: true,
    host,
    url: normalizedUrl,
    group,
    isUrlProxy: isUrlProxyName(group),
    bestNode: best?.name ?? null,
    bestDelay: best?.delay ?? null,
    switched,
    candidatesTested: candidates.length,
    testUrl: normalizedUrl,
  }
  if (opts.json) {
    console.log(JSON.stringify({ ...result, top: display.map((r) => ({ name: r.name, delay: r.delay })) }))
    return
  }
  console.log(`目标: ${host}  (${normalizedUrl})`)
  console.log(`切换组: ${group}${isUrlProxyName(group) ? ' (网址代理组)' : ' (GLOBAL 兜底)'}`)
  console.log(`测速节点: ${candidates.length} 个`)
  if (display.length === 0) {
    console.log('⚠  无可用节点（全部超时/失败）')
  } else {
    console.log('延迟最低:')
    for (const r of display) {
      const mark = r.name === best?.name ? ' ◀' : ''
      console.log(`  ${String(r.delay).padStart(6)} ms  ${r.name}${mark}`)
    }
  }
  if (switched) console.log(`✓ 已切换 ${group} → ${best.name} (${best.delay} ms)`)
  else if (!testOnly && best) console.log(`✗ 切换失败（HTTP ${switchStatus}；组可能不存在，可用 --group 显式指定）`)
  else if (testOnly) console.log('(仅测速，未切换)')
  if (!isUrlProxyName(group)) {
    console.log('ℹ  该域名无网址代理组，已回退 GLOBAL。rule 模式下只有未匹配规则的流量走它；')
    console.log('   如需精准路由，请先用 `clash-proxy add <url>` 自动建组。')
  }
  console.log(`下载: curl --proxy http://127.0.0.1:${process.env.CLASH_MIXED_PORT ?? DEFAULT_MIXED_PORT} -L -O '${url}'`)
}

/** 进度渲染：TTY 下用 \r 刷新一行，管道输出时只在开始时提示 */
function makeProgressRenderer(jsonMode) {
  let started = null
  let lastRender = 0
  return (p) => {
    if (jsonMode) return // --json 模式不刷屏，最终一次性输出 JSON
    if (!started) started = Date.now()
    const now = Date.now()
    if (now - lastRender < 300) return // 节流
    lastRender = now
    const pct = p.total && p.total > 0 ? Math.min(100, Math.round((p.doneBytes / p.total) * 100)) : '?'
    const line = `\r⏬ ${p.filename}  ${pct}%  ${formatBytes(p.doneBytes)}/${p.total ? formatBytes(p.total) : '?'}  ${p.speed}  ${p.threads}线程`
    process.stdout.write(line.padEnd(Math.min(process.stdout.columns ?? 100, 100)))
  }
}

function formatBytes(n) {
  if (n == null || isNaN(n)) return '?'
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GiB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MiB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + ' KiB'
  return n + ' B'
}

/** dl：选节点（add 语义：无组自动建）+ 走代理多线程下载 */
async function cmdDownload(url, opts) {
  const { host, url: normalizedUrl } = parseHost(url)
  let proxyPort = opts.noProxy ? null : Number(process.env.CLASH_MIXED_PORT ?? DEFAULT_MIXED_PORT)
  let group = null
  let best = null
  let offline = false

  if (!opts.noProxy) {
    // 复用 add 语义：探测命中组，无则自动建，然后测速切换
    try {
      group = opts.group
      if (!group) {
        const rules = (await request('GET', '/rules')).json?.rules ?? []
        group = detectUrlProxyGroup(rules, host)
      }
      // --json 模式：提示信息走 stderr，避免污染 stdout 的 JSON 输出
      const log = (msg) => (opts.json ? console.error(msg) : console.log(msg))
      if (!group) {
        group = await createUrlProxyGroup(host)
        if (group) log(`✓ 已创建网址代理组 ${group}（${host}）`)
      }
      if (group) {
        const { best: b, candidates } = await testAndSwitch(group, host, normalizedUrl, opts, false)
        best = b
        if (best) log(`✓ 已切换 ${group} → ${best.name} (${best.delay} ms)`)
        else log(`⚠ 组 ${group} 无可测节点，仍走代理下载（可能用 GLOBAL/兜底）`)
      } else {
        log('⚠ 未检测到可用节点，仍尝试走代理下载')
      }
    } catch (e) {
      if (['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET'].includes(e?.code)) {
        console.error('⚠️ 未检测到 Clash 在运行（连接失败: ' + e.message + '）')
        console.error('已跳过选节点，降级为直连下载。如需走代理，请先启动 Clash Verge Rev。')
        proxyPort = null
        offline = true
      } else {
        console.error('clash-proxy 选节点失败:', e.message)
        console.error('已跳过选节点，仍尝试走代理下载。')
      }
    }
  }

  const render = makeProgressRenderer(opts.json)
  let res
  try {
    res = await dlDownload(normalizedUrl, {
      proxyPort,
      threads: opts.threads,
      output: opts.output,
      dir: opts.dir,
      forceNode: opts.forceNode,
      headers: opts.headers,
      jsonMode: opts.json,
      onProgress: render,
    })
  } catch (e) {
    // 下载阶段连接类错误：代理端口不可用 / 管道中断 → 降级直连重试一次
    if (proxyPort && RETRYABLE_CODES.has(e?.code)) {
      const log = (msg) => (opts.json ? console.error(msg) : console.log(msg))
      log(`⚠️ 走代理下载失败（${e.message}），降级为直连下载。`)
      res = await dlDownload(normalizedUrl, {
        proxyPort: null,
        threads: opts.threads,
        output: opts.output,
        dir: opts.dir,
        forceNode: opts.forceNode,
        headers: opts.headers,
        jsonMode: opts.json,
        onProgress: render,
      })
    } else {
      throw e
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      ok: res.ok,
      host,
      url: normalizedUrl,
      group,
      bestNode: best?.name ?? null,
      bestDelay: best?.delay ?? null,
      proxy: proxyPort ? `http://127.0.0.1:${proxyPort}` : null,
      engine: res.engine ?? null,
      filePath: res.filePath ?? null,
      bytes: res.bytes ?? null,
      threads: res.threads ?? null,
      durationMs: res.durationMs ?? null,
      error: res.ok ? null : (res.error ?? (res.exitCode != null ? `退出码 ${res.exitCode}` : null)),
      errorCode: res.ok ? null : (res.errorCode ?? null),
    }))
    if (res.ok) return
    process.exitCode = 1
    return // --json 失败也到此为止：不落入人类可读分支（其 \r\x1b[K 会污染 stdout 的 JSON）
  }

  if (res.ok) {
    process.stdout.write('\r\x1b[K')
    if (res.filePath) {
      console.log(`✓ 下载完成  ${res.filePath}  ${formatBytes(res.bytes)}  （${res.engine} ${res.threads} 线程, ${(res.durationMs / 1000).toFixed(1)}s）`)
    } else {
      console.log('✓ aria2c 下载完成')
    }
  } else {
    process.stdout.write('\r\x1b[K')
    console.error(`✗ 下载失败: ${res.error ?? `退出码 ${res.exitCode}`}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  // 连接类错误 = Clash Verge Rev / mihomo 没在运行（命名管道不存在、HTTP 端口拒绝、管道被断）
  if (['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET'].includes(e?.code)) {
    console.error(`⚠️ 未检测到 Clash 在运行（连接失败: ${e.message}）`)
    console.error('已跳过测速。如需走代理选节点下载，请先启动 Clash Verge Rev。')
  } else {
    console.error('clash-proxy 错误:', e.message)
  }
  process.exit(1)
})
