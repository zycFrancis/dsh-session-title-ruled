#!/usr/bin/env python3
"""盘点 ~/.dsh/sessions 存量会话,产出批量补名工作清单。

分类(与规则对齐):
  skip-subagent  子代理会话(有 parentSession),不在侧栏主列表
  skip-nomsgs    没有合格人类消息,无从命名
  keep-user      现标题为用户手动改名(source=user),规则:用户自定义优先
  keep-dot       现标题命中 dot 编号体系(^\d{2}｜),规则:编号保持不变
  already-ruled  现标题已是 MMDD｜八类型｜ 格式
  locked         锁被活会话持有(改文件会被内存态覆盖)
  todo           需要批量补名 → 进工作清单
"""
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path.home() / '.dsh' / 'sessions'
TYPES = ['研究', '量化', '开发', '配置', '排障', '管理', '创作', '日常']
RULED = re.compile(r'^\d{4}｜(研究|量化|开发|配置|排障|管理|创作|日常)｜')
DOT = re.compile(r'^\d{2}｜')
CTRL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]')


def decompress(path):
    out = subprocess.run(['zstd', '-d', '-c', str(path)], capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode()[:200])
    return out.stdout.decode('utf-8', 'replace')


def try_lock(session_dir):
    """探测 session.lock 是否被活会话持有;持锁返回 True。"""
    import fcntl
    lock = session_dir / 'session.lock'
    if not lock.exists():
        return False
    try:
        fd = lock.open('rb+')
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        fd.close()


def clean(text, cap):
    text = CTRL.sub('', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:cap]


def main():
    inventory = []
    worklist = []
    for zstd_file in sorted(ROOT.glob('*/*/session.v4.jsonl.zstd')):
        session_dir = zstd_file.parent
        try:
            raw = decompress(zstd_file)
        except Exception as error:
            inventory.append({'status': 'unreadable', 'dir': str(session_dir), 'error': str(error)})
            continue
        lines = raw.splitlines()
        if not lines:
            continue
        try:
            header = json.loads(lines[0])
        except json.JSONDecodeError:
            inventory.append({'status': 'unreadable', 'dir': str(session_dir), 'error': 'bad header'})
            continue
        sid = header.get('id', session_dir.name)
        if header.get('parentSession') is not None:
            inventory.append({'status': 'skip-subagent', 'id': sid, 'dir': session_dir.name})
            continue

        msgs = []          # 合格人类消息 (seq, text)
        last_seq = 0
        title = None
        title_source = None
        for line in lines[1:]:
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            last_seq = max(last_seq, event.get('seq', 0))
            etype = event.get('type')
            if etype == 'user/message':
                data = event.get('data') or {}
                source = data.get('source') or {}
                if source.get('kind') == 'user':
                    text = '\n'.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text')
                    if clean(text, 1):
                        msgs.append({'seq': event.get('seq', 0), 'text': text})
            elif etype == 'session/title':
                data = event.get('data') or {}
                title = data.get('title')
                title_source = (data.get('source') or {}).get('kind')

        base = {'id': sid, 'dir': session_dir.name, 'cwd': header.get('cwd', ''), 'msgs': len(msgs)}
        if not msgs:
            base['status'] = 'skip-nomsgs'
        elif title is not None and title_source == 'user':
            base['status'] = 'keep-user'
        elif title is not None and DOT.match(title):
            base['status'] = 'keep-dot'
        elif title is not None and RULED.match(title):
            base['status'] = 'already-ruled'
        elif try_lock(session_dir):
            base['status'] = 'locked'
        else:
            base['status'] = 'todo'
            created = header.get('createdAt', 0)
            stamp = datetime.fromtimestamp(created / 1000).strftime('%m%d')
            selected = msgs if len(msgs) <= 8 else [msgs[0], *msgs[-7:]]
            worklist.append({
                'id': sid,
                'dir': str(session_dir),
                'stamp': stamp,
                'nextSeq': last_seq + 1,
                'messages': [{'seq': m['seq'], 'text': clean(m['text'], 400)} for m in selected],
            })
        inventory.append(base)

    counts = {}
    for item in inventory:
        counts[item['status']] = counts.get(item['status'], 0) + 1
    print(json.dumps(counts, ensure_ascii=False, indent=1))
    Path('/tmp/batchrename-worklist.json').write_text(json.dumps(worklist, ensure_ascii=False, indent=1))
    Path('/tmp/batchrename-inventory.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=1))
    print(f'worklist: {len(worklist)} -> /tmp/batchrename-worklist.json')


if __name__ == '__main__':
    main()
