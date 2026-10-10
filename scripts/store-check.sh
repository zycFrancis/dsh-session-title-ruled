#!/usr/bin/env bash
# 会话存储只读体检:目录 slug 与 header.cwd 是否错位、解压是否完好。
# 依据 docs/store-safety.md 的不变式;输出异常数,非 0 即退出码 1。
# 用法: bash scripts/store-check.sh [sessions根目录,默认 $DSH_HOME 或 ~/.dsh/sessions]
set -euo pipefail
ROOT="${1:-${DSH_HOME:-$HOME/.dsh}/sessions}"
[ -d "$ROOT" ] || { echo "目录不存在: $ROOT"; exit 2; }
python3 - "$ROOT" <<'PY'
import json, subprocess, sys
from pathlib import Path
root = Path(sys.argv[1])
bad = 0
for slug_dir in sorted(root.iterdir()):
    if not slug_dir.is_dir():
        continue
    for f in sorted(slug_dir.glob('*/session.v4.jsonl.zstd')):
        out = subprocess.run(['zstd', '-dc', str(f)], capture_output=True)
        if out.returncode != 0:
            print('解压失败', f); bad += 1; continue
        first = out.stdout.decode('utf-8', 'replace').splitlines()[0] if out.stdout else ''
        try:
            header = json.loads(first)
        except Exception as error:
            print('header解析失败', f, error); bad += 1; continue
        cwd = header.get('cwd', '')
        expected = '--' + cwd[1:].replace('/', '-') + '--' if isinstance(cwd, str) and cwd.startswith('/') else None
        if expected != slug_dir.name:
            print('错位', f.parent, 'cwd=', cwd); bad += 1
print(f'扫描 {root}: 异常 {bad}')
sys.exit(1 if bad else 0)
PY
