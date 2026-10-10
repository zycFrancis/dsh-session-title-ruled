# 会话存储安全红线(事故教训)

背景:2026-10-10,一次存储外的手工测试脚本在 `~/.dsh/sessions/--Users-zyc--/` 下创建了一个
克隆会话目录,但其 header 的 `cwd` 指向 `/private/tmp`。下次启动时 workspaceRegistry
因"目录与头部工作区不一致"启动失败,整个 dsh 无法进入。修复:把文件移到 header 声明的
slug 目录。本文件把教训固化成红线,任何脚本/人不得再踩。

## 存储布局不变式

- 会话文件路径:`~/.dsh/sessions/<slug>/<session-id>/session.v4.jsonl.zstd`。
- **slug 必须由 header.cwd 推导**:`'--' + cwd[1:].replace('/', '-') + '--'`
  (如 `/Users/zyc` → `--Users-zyc--`;`/private/tmp` → `--private-tmp--`)。
- 目录 slug 与 header.cwd 不一致 ⇒ 宿主启动扫描失败 ⇒ **整个 app 起不来**。这不是
  单会话损坏,是全局故障。

## 红线

1. **禁止手工在 `~/.dsh/sessions` 下 mkdir/mv/rm 会话目录**。需要合成/克隆会话做测试时,
   header 的 `cwd` 必须与所在 slug 目录一致,并在测试后立即清理;脚本必须先写清单后执行,
   清单(含全部目录名)在创建任何目录之前落盘,防止中途崩溃留下无人知晓的孤儿。
2. 修改既有会话文件只允许"原字节不动 + 新事件压独立 zstd 帧追加"(见
   `scripts/batch-rename/batchrename-apply.py` 的 `frame_bytes` 注释);整文重压会破坏
   "首帧恰好一行 header"的强校验,导致会话能列出、打不开。
3. 动文件前探活锁(`session.lock` flock);持锁会话一律跳过。
4. 批量操作先备份原始字节,保留可整体回滚的能力。

## 快速体检(只读)

```bash
# 全库扫描:目录 slug 与 header.cwd 是否错位(应输出 0)
python3 - <<'PY'
import json, subprocess
from pathlib import Path
root = Path.home() / '.dsh' / 'sessions'
bad = 0
for slug_dir in sorted(root.iterdir()):
    if not slug_dir.is_dir(): continue
    for f in sorted(slug_dir.glob('*/session.v4.jsonl.zstd')):
        out = subprocess.run(['zstd', '-dc', str(f)], capture_output=True)
        if out.returncode != 0:
            print('解压失败', f); bad += 1; continue
        header = json.loads(out.stdout.decode('utf-8', 'replace').splitlines()[0] or '{}')
        cwd = header.get('cwd', '')
        expected = '--' + cwd[1:].replace('/', '-') + '--' if cwd.startswith('/') else None
        if expected != slug_dir.name:
            print('错位', f.parent, 'cwd=', cwd); bad += 1
print('异常:', bad)
PY
```
