#!/usr/bin/env bash
# DSH_HOME 沙箱演示:在完全隔离的会话存储里跑一次真实对话,证明不碰真实 ~/.dsh。
#
# 原理:dsh 尊重 DSH_HOME 环境变量——profiles、sessions、storages 全部落在
# $DSH_HOME 下。把 DSH_HOME 指向一次性目录,里面无论发生什么(包括把存储写坏)
# 都影响不到真实库;测完整个目录一删即净。
#
# 用法:
#   bash scripts/sandbox-demo.sh "你的测试提示"     # 默认沙箱 /tmp/dsh-sandbox
#   SB_HOME=/path bash scripts/sandbox-demo.sh "…"  # 自定义沙箱位置
# 需要:ZAI_CODING_CN_API_KEY 在环境中(否则标题停在 fallback,隔离性验证不受影响)。
set -euo pipefail

PROMPT="${1:-用一句话解释什么是夏普比率}"
SB="${SB_HOME:-/tmp/dsh-sandbox}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REAL="${DSH_HOME:-$HOME/.dsh}"

# 红线:沙箱绝不允许指向真实 DSH_HOME。
if [ "$(cd "$SB" 2>/dev/null && pwd)" = "$(cd "$REAL" && pwd)" ] || [ "$SB" = "$REAL" ]; then
  echo "拒绝:沙箱 DSH_HOME 指向了真实存储 $REAL" >&2
  exit 2
fi

echo "== 沙箱: $SB (真实存储 $REAL 不受影响)"
mkdir -p "$SB/profiles/sb"
cat > "$SB/profiles/sb/package.json" <<EOF
{
  "name": "dsh-profile-sandbox",
  "private": true,
  "dependencies": { "dsh-session-title-ruled": "link:$REPO" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-session-title-ruled"] } }
}
EOF
printf 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$SB/profiles/sb/pnpm-workspace.yaml"
cat > "$SB/profiles/sb/cordis.patch.yml" <<'EOF'
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      zai-coding-cn:
        apiKeyEnv: ZAI_CODING_CN_API_KEY
        models:
          - id: glm-5.3-flash
            name: GLM 5.3 Flash
            contextWindow: 200000
            maxTokens: 131072
            input: [text]
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: zai-coding-cn, model: glm-5.3-flash }
- id: session-title-llm
  disabled: true
- id: session-title-ruled
  config: { provider: zai-coding-cn, model: glm-5.3-flash }
EOF
( cd "$SB/profiles/sb" && pnpm install --silent ) >/dev/null

REAL_BEFORE=$(find "$REAL/sessions" -name 'session.v4.jsonl.zstd' 2>/dev/null | wc -l | tr -d ' ')
echo "== 真实存储文件数(前): $REAL_BEFORE"

echo "== 沙箱对话开始"
( cd /tmp && DSH_HOME="$SB" dsh --profile sb "$PROMPT" ) || true

echo "== 沙箱产物:"
find "$SB/sessions" -name 'session.v4.jsonl.zstd' 2>/dev/null | while read -r f; do
  echo "  $f"
  zstd -dc "$f" | grep '"type":"session/title"' | tail -1 | sed 's/^/    /'
done

REAL_AFTER=$(find "$REAL/sessions" -name 'session.v4.jsonl.zstd' 2>/dev/null | wc -l | tr -d ' ')
echo "== 真实存储文件数(后): $REAL_AFTER ($([ "$REAL_BEFORE" = "$REAL_AFTER" ] && echo '零接触 ✓' || echo '有变化 ⚠'))"
echo "== 清理: rm -rf $SB   (需要时手动执行)"
