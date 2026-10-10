#!/usr/bin/env bash
# 会话存储只读体检:目录 slug 与 header.cwd 是否错位、解压是否完好、
# slug 目录下有无 legacy 布局散落文件(宿主启动即抛的那类)。
#
# 注意:slug 公式是宿主 projectKey 的常见情形简化;连续斜杠、根路径、
# 含空格/CJK/~ 的 cwd 等异构路径可能误报。输出「疑似」时先按
# docs/store-safety.md 复核宿主规则,切勿据此直接移动文件。
# 用法: bash scripts/store-check.sh [sessions根目录,默认 $DSH_HOME 或 ~/.dsh/sessions]
set -euo pipefail
ROOT="${1:-${DSH_HOME:-$HOME/.dsh}/sessions}"
[ -d "$ROOT" ] || { echo "目录不存在: $ROOT"; exit 2; }
python3 - "$ROOT" <<'PY'
import json, subprocess, sys
from pathlib import Path

root = Path(sys.argv[1])
bad = 0

def slug_of(cwd):
    """宿主 projectKey 的常见情形简化;异构 cwd 可能偏差,故只报「疑似」。"""
    if not isinstance(cwd, str) or not cwd.startswith('/'):
        return None
    return '--' + cwd[1:].replace('/', '-') + '--'

for slug_dir in sorted(root.iterdir()):
    if not slug_dir.is_dir():
        continue
    # legacy 布局:slug 目录下直接散落的 *.jsonl / *.jsonl.zst(非会话子目录内)
    for stray in sorted(slug_dir.glob('*.jsonl*')):
        print(f'legacy散落文件(宿主启动即抛): {stray}')
        bad += 1
    for f in sorted(slug_dir.glob('*/session.v4.jsonl.zstd')):
        out = subprocess.run(['zstd', '-dc', str(f)], capture_output=True)
        if out.returncode != 0:
            print(f'解压失败: {f}')
            bad += 1
            continue
        text = out.stdout.decode('utf-8', 'replace')
        first = text.split('\n', 1)[0].strip()
        if not first:
            print(f'空日志: {f}')
            bad += 1
            continue
        try:
            header = json.loads(first)
        except json.JSONDecodeError as error:
            print(f'header解析失败(勿动文件,先备份再诊断): {f} {error}')
            bad += 1
            continue
        if slug_of(header.get('cwd')) != slug_dir.name:
            print(f'疑似错位(简化公式;异构cwd需按宿主规则复核,勿直接移动): {f.parent} cwd={header.get("cwd")!r}')
            bad += 1

stray_zst = sum(1 for _ in root.rglob('*.zst'))
print(f'扫描 {root}: 异常 {bad};惰性 .zst 残留 {stray_zst} 个(宿主忽略,仅提示)')
sys.exit(1 if bad else 0)
PY
