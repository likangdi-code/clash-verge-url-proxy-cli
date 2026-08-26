#!/usr/bin/env sh
# install.sh — clash-proxy 一键安装（macOS / Linux，只装工具，不装 skill）
#
# 用法（终端一行）：
#   curl -fsSL https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main/install.sh | sh
#
# 效果：
#   - 安装 clash-proxy.mjs + clash-proxy 命令到 ~/.local/bin 并加入 PATH
#   - 幂等：重复运行只覆盖更新
#   - 只装工具；skill 由各 agent 工具单独部署（deploy-agents.ps1，需要 pwsh）
set -e

REPO=https://raw.githubusercontent.com/likangdi-code/clash-verge-url-proxy-cli/main
INSTALL_DIR="${HOME}/.local/bin"

# 1. 前置检查：Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 Node.js，请先安装（https://nodejs.org）后重试。" >&2
  exit 1
fi

# 2. 创建目录
mkdir -p "$INSTALL_DIR"

# 3. 下载主脚本 + 独立下载引擎 + vendored js-yaml（dl 多线程下载 / add 解析 YAML 用）
echo "下载 clash-proxy.mjs -> $INSTALL_DIR"
curl -fsSL "$REPO/clash-proxy.mjs" -o "$INSTALL_DIR/clash-proxy.mjs"
curl -fsSL "$REPO/downloader.mjs" -o "$INSTALL_DIR/downloader.mjs"
mkdir -p "$INSTALL_DIR/vendor"
curl -fsSL "$REPO/vendor/js-yaml.mjs" -o "$INSTALL_DIR/vendor/js-yaml.mjs"

# 4. 生成 clash-proxy + clash-dl 命令包装
cat > "$INSTALL_DIR/clash-proxy" <<'WRAP'
#!/usr/bin/env sh
exec node "$(dirname "$0")/clash-proxy.mjs" "$@"
WRAP
chmod +x "$INSTALL_DIR/clash-proxy"

cat > "$INSTALL_DIR/clash-dl" <<'WRAP'
#!/usr/bin/env sh
exec node "$(dirname "$0")/clash-proxy.mjs" dl "$@"
WRAP
chmod +x "$INSTALL_DIR/clash-dl"

# 4.5 aria2c 多线程下载引擎（dl/clash-dl 的主引擎）：已装跳过；
#     未装尝试包管理器自动安装（失败不阻塞——clash-dl 会用内置 Node 分片下载器兜底）
if ! command -v aria2c >/dev/null 2>&1; then
  echo "尝试安装 aria2c 多线程下载引擎…"
  if command -v brew >/dev/null 2>&1; then
    brew install aria2 || echo "（brew 安装失败，可稍后手动: brew install aria2）"
  elif command -v apt-get >/dev/null 2>&1; then
    sudo -n apt-get install -y aria2 2>/dev/null || echo "（需要 sudo 权限，可稍后手动: sudo apt-get install aria2）"
  elif command -v dnf >/dev/null 2>&1; then
    sudo -n dnf install -y aria2 2>/dev/null || echo "（需要 sudo 权限，可稍后手动: sudo dnf install aria2）"
  elif command -v pacman >/dev/null 2>&1; then
    sudo -n pacman -S --noconfirm aria2 2>/dev/null || echo "（需要 sudo 权限，可稍后手动: sudo pacman -S aria2）"
  else
    echo "（未识别到包管理器，可手动安装 aria2c 获得多线程下载）"
  fi
else
  echo "aria2c 已可用（多线程下载引擎），跳过安装"
fi

# 5. 加入 PATH（幂等：追加到第一个存在的 rc 文件）
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *)
    rc=""
    for f in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$f" ]; then rc="$f"; break; fi
    done
    if [ -n "$rc" ]; then
      {
        echo ""
        echo 'export PATH="$HOME/.local/bin:$PATH"'
      } >> "$rc"
      echo "已追加 PATH 到 $rc"
    else
      echo "提示：请把 $INSTALL_DIR 加入 PATH（未找到 .zshrc/.bashrc/.profile）"
    fi
    ;;
esac

# 6. 下载 deploy-agents.ps1 备用（skill 部署脚本，不执行）
if ! curl -fsSL "$REPO/deploy-agents.ps1" -o "$INSTALL_DIR/deploy-agents.ps1" 2>/dev/null; then
  echo "（deploy-agents.ps1 下载失败，可稍后手动获取）"
fi

# 7. 汇总提示
echo ""
echo "✓ clash-proxy 工具安装完成（未安装 skill）。"
if command -v aria2c >/dev/null 2>&1; then
  echo "  下载引擎: aria2c（多线程主引擎，RPC 控制）"
else
  echo "  下载引擎: 内置 Node 分片下载器（aria2c 未就绪，可手动安装获得多线程加速）"
fi
echo "  新开终端后可直接："
echo "    clash-proxy list"
echo "    clash-proxy pick \"https://example.com/big-file.zip\""
echo "    clash-dl \"https://example.com/big-file.zip\"   （独立多线程下载）"
echo ""
echo "▶ 部署 skill 到本机所有 agent 工具（需 pwsh；macOS: brew install powershell）："
echo "    pwsh -File \"$INSTALL_DIR/deploy-agents.ps1\""
echo "  只装到当前 agent："
echo "    pwsh -File \"$INSTALL_DIR/deploy-agents.ps1\" -Agent claude"
echo "  可用的 -Agent 值：claude / gemini / codex / opencode / hermes / openclaw / grok / agents"
