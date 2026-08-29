<#
  deploy-agents.ps1 — 把 clash-proxy 的 Agent Skill 部署到本机各 AI agent 工具

  默认部署两个 skill：
    clash-proxy      — 工具使用说明（下载/选节点）
    clash-proxy-fix  — 安装与排障修复

  覆盖工具（检测到对应目录就装；统一 SKILL.md 开放标准）：
    claude / codebuddy / workbuddy / gemini / codex / opencode / hermes / openclaw / grok

  用法：
    powershell -ExecutionPolicy Bypass -File deploy-agents.ps1
        # 部署两个 skill 到本机【所有】已检测到的 agent 工具（默认从 GitHub raw 拉取）
    powershell -ExecutionPolicy Bypass -File deploy-agents.ps1 -Agent claude
        # 只装到【指定】工具（可逗号分隔多个：-Agent "claude,codex"；供某个 agent 自己给自己装 skill）
    powershell -ExecutionPolicy Bypass -File deploy-agents.ps1 -SourcePath .\skills\clash-proxy\SKILL.md -SkillName clash-proxy
        # 用本地 SKILL.md 部署单个自定义 skill（离线 / 开发时）

  结束后会汇总「已安装到哪些」「未检测到哪些」，方便你确认还有哪些工具需要单独处理。
#>
param(
  [string]$SkillUrl = '',        # 显式指定单个 skill 的下载 URL（配 -SkillName）
  [string]$SourcePath = '',      # 用本地 SKILL.md（配 -SkillName）
  [string]$Agent = '',           # 只部署指定工具：claude/codebuddy/workbuddy/gemini/codex/opencode/hermes/openclaw/grok
  [string]$SkillName = 'clash-proxy'   # 配合 -SkillUrl/-SourcePath 自定义 skill 时用
)
$ErrorActionPreference = 'Continue'

# 1. 确定要部署的 skills 清单（默认两个；显式传了 SkillUrl/SourcePath 则只部署这一个）
$repoBase = 'https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main'
$repoRaw  = 'https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli'
$apiBase  = 'https://api.github.com/repos/likangdi-code/clash-verge-url-proxy-cli'
if ($SkillUrl -or $SourcePath) {
  $skills = @(@{ name = $SkillName; url = $SkillUrl; src = $SourcePath })
} else {
  $skills = @(
    @{ name = 'clash-proxy';     url = "$repoBase/skills/clash-proxy/SKILL.md";     src = '' },
    @{ name = 'clash-proxy-fix'; url = "$repoBase/skills/clash-proxy-fix/SKILL.md"; src = '' }
  )
}

# 版本/校验：查最新 commit 与 SKILL.md 的 git blob SHA-1，下载后比对（API 不可用时降级）
function Get-GitLatestSha {
  try { return (Invoke-RestMethod -Uri "$apiBase/commits/main" -Headers @{ 'User-Agent' = 'clash-proxy-install' } -UseBasicParsing).sha } catch { return $null }
}
function Get-GitFileShas {
  param([string]$Ref)
  try {
    # 注意：必须写成 ${Ref}——PowerShell 变量名可含 '?'，$Ref?recursive 会把 ?recursive 吞进变量名
    $r = Invoke-RestMethod -Uri "$apiBase/git/trees/${Ref}?recursive=1" -Headers @{ 'User-Agent' = 'clash-proxy-install' } -UseBasicParsing
    $m = @{}; foreach ($t in $r.tree) { if ($t.type -eq 'blob') { $m[$t.path] = $t.sha } }
    return $m
  } catch { return $null }
}
function Get-GitBlobSha([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  $bytes = [IO.File]::ReadAllBytes($Path)
  $header = [Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)`0")
  $all = New-Object byte[] ($header.Length + $bytes.Length)
  [Array]::Copy($header, 0, $all, 0, $header.Length)
  [Array]::Copy($bytes, 0, $all, $header.Length, $bytes.Length)
  return (( [Security.Cryptography.SHA1]::Create().ComputeHash($all) | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Invoke-DownloadChecked {
  param([string]$Url, [string]$Dest, [string]$ExpectedSha, [int]$Retries = 3)
  for ($i = 1; $i -le $Retries; $i++) {
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
    $actual = Get-GitBlobSha $Dest
    if ($actual -eq $ExpectedSha) { return $true }
    Write-Host "    哈希不一致（预期 $($ExpectedSha.Substring(0, 8))… 实际 $($actual.Substring(0, 8))…），$($Retries - $i) 次后重试…" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
  }
  return $false
}

# 2. 各 agent 工具： key -> (检测目录, skills 目录, 显示名)
$targets = @(
  @{ key = 'claude';     name = 'Claude Code'; dir = "$HOME\.claude";           skills = "$HOME\.claude\skills" },
  @{ key = 'codebuddy';  name = 'CodeBuddy';   dir = "$HOME\.codebuddy";        skills = "$HOME\.codebuddy\skills" },
  @{ key = 'workbuddy';  name = 'WorkBuddy';   dir = "$HOME\.workbuddy-ai";     skills = "$HOME\.workbuddy-ai\skills" },
  @{ key = 'gemini';     name = 'Gemini';      dir = "$HOME\.gemini";           skills = "$HOME\.gemini\skills" },
  @{ key = 'codex';      name = 'Codex';       dir = "$HOME\.codex";            skills = "$HOME\.codex\skills" },
  @{ key = 'opencode';   name = 'OpenCode';    dir = "$HOME\.config\opencode";  skills = "$HOME\.config\opencode\skills" },
  @{ key = 'hermes';     name = 'Hermes';      dir = "$HOME\.hermes";           skills = "$HOME\.hermes\skills" },
  @{ key = 'openclaw';   name = 'OpenClaw';    dir = "$HOME\.openclaw";         skills = "$HOME\.openclaw\skills" },
  @{ key = 'grok';       name = 'Grok';        dir = "$HOME\.grok";             skills = "$HOME\.grok\skills" }
)

# 过滤：-Agent 指定了则只处理该工具（支持逗号分隔多值，如 "claude,codex"）
if ($Agent) {
  $agentKeys = $Agent -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $unknown = $agentKeys | Where-Object { $_ -notin $targets.key }
  if ($unknown) {
    Write-Error "未知工具: $($unknown -join ',')。可用：claude / codebuddy / workbuddy / gemini / codex / opencode / hermes / openclaw / grok"
    exit 1
  }
  $targets = $targets | Where-Object { $_.key -in $agentKeys }
}

Write-Host ''
$scope = if ($Agent) { "指定工具 [$Agent]" } else { '本机所有 agent 工具' }
$skillList = ($skills | ForEach-Object { $_.name }) -join ' + '
Write-Host "部署 Skill [$skillList] 到 $scope：" -ForegroundColor Cyan

# 2.5 查最新 commit 与 SKILL.md 哈希（API 不可用时降级：跳过校验直接下载）
$latestSha = Get-GitLatestSha
$treeShas = if ($latestSha) { Get-GitFileShas $latestSha } else { $null }
if (-not $latestSha) {
  Write-Host '⚠ 无法访问 GitHub API，跳过哈希校验（仍正常下载部署）。' -ForegroundColor Yellow
}

$installed = @()   # { skill, name, dest }
$missing = @()     # { name, key, skillsDir } 工具未检测到
foreach ($t in $targets) {
  if (Test-Path $t.dir) {
    foreach ($s in $skills) {
      # 3. 准备 SKILL.md（本地文件或网络下载），按 skill 名分目录缓存
      $tmp = Join-Path $env:TEMP "deploy-agents-$($s.name)"
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      $skillFile = Join-Path $tmp 'SKILL.md'
      if ($s.src) {
        if (-not (Test-Path $s.src)) { Write-Error "本地 SKILL.md 不存在: $($s.src)"; exit 1 }
        Copy-Item $s.src $skillFile -Force
      } else {
        # 下载 SKILL.md：temp 缓存与最新版本哈希一致则复用，否则重新下载
        # 下载后用 git blob SHA-1 校验（与 GitHub 官方树比对，重试兜底 CDN 缓存延迟）
        $expected = if ($treeShas) { $treeShas["skills/$($s.name)/SKILL.md"] } else { $null }
        if ($expected -and (Test-Path $skillFile) -and ((Get-GitBlobSha $skillFile) -eq $expected)) {
          Write-Host "已是最新 SKILL.md（$($s.name)），跳过下载" -ForegroundColor DarkGray
        } else {
          # 用 commit SHA 路径下载（不可变对象，绕开 main 分支 CDN 渐进缓存）
          $url = if ($latestSha) { "$repoRaw/$latestSha/skills/$($s.name)/SKILL.md" } else { $s.url }
          try {
            if ($expected) {
              if (-not (Invoke-DownloadChecked $url $skillFile $expected)) {
                Write-Error "下载 $($s.name) SKILL.md 哈希校验失败（GitHub CDN 缓存延迟），请稍后重试。"
                exit 1
              }
            } else {
              Invoke-WebRequest -Uri $url -OutFile $skillFile -UseBasicParsing
            }
            Write-Host "已下载 SKILL.md: $url" -ForegroundColor DarkGray
          } catch {
            Write-Error "下载 SKILL.md 失败: $($_.Exception.Message)"
            exit 1
          }
        }
      }
      $dest = Join-Path $t.skills $s.name
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      Copy-Item $skillFile (Join-Path $dest 'SKILL.md') -Force
      Write-Host "  [✓] $($t.name)  <-  $($s.name)  ->  $dest" -ForegroundColor Green
      $installed += @{ skill = $s.name; name = $t.name; dest = $dest }
    }
  } else {
    Write-Host "  [–] $($t.name)  未检测到（工具未安装），跳过" -ForegroundColor DarkGray
    $missing += @{ name = $t.name; key = $t.key; skillsDir = $t.skills }
  }
}

# 4. 汇总：已安装 / 未检测到（可能要单独安装 skill）
Write-Host ''
if ($installed.Count) {
  Write-Host '✓ 已安装 skill 到：' -ForegroundColor Green -NoNewline
  Write-Host (($installed | ForEach-Object { "$($_.name)[$($_.skill)]" }) -join '、')
} else {
  Write-Host '✗ 未安装到任何工具。' -ForegroundColor Yellow
}
if ($missing.Count) {
  Write-Host ''
  Write-Host '⚠ 以下工具未检测到（对应 agent 未安装或目录不同），可能需要单独安装 skill：' -ForegroundColor Yellow
  foreach ($m in $missing) {
    Write-Host "  · $($m.name) — 装好该工具后重跑本脚本即可自动部署；或手动把 SKILL.md 复制到：$($m.skillsDir)\<skill名>\SKILL.md"
  }
}

# 5. 提示
Write-Host ''
if ($Agent) {
  Write-Host "已完成 [$Agent] 的 skill 部署。" -ForegroundColor DarkGray
} else {
  Write-Host '提示：已装工具重启会话（或 /skills reload）后即可自主调用 clash-proxy。' -ForegroundColor DarkGray
  Write-Host '单个工具单独补装：powershell -ExecutionPolicy Bypass -File deploy-agents.ps1 -Agent <claude|codebuddy|workbuddy|gemini|codex|opencode|hermes|openclaw|grok>' -ForegroundColor DarkGray
}
