#!/usr/bin/env python3
"""批量补名应用脚本:把分类结果作为 session/title 事件追加进存量会话日志。

安全设计:
  - 只处理 worklist ∩ results 的交集,逐项再次校验(id 回填一致、类型在枚举内、名称清洗);
  - 写前再探活锁,持锁跳过;文件实际末位 seq 与盘点不一致时以实际为准并重查现标题;
  - 原始压缩字节先备份到 ~/.dsh/batchrename-backup/;
  - 原子替换(同目录临时文件 + os.replace);
  - 事件 envelope 严格对齐宿主校验:{type,seq,time,data},seq 连续。
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path.home() / '.dsh' / 'sessions'
BACKUP = Path.home() / '.dsh' / 'batchrename-backup'
TYPES = ['研究', '量化', '开发', '配置', '排障', '管理', '创作', '日常']
RULED = re.compile(r'^\d{4}｜(研究|量化|开发|配置|排障|管理|创作|日常)｜')
DOT = re.compile(r'^\d{2}｜')
CTRL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]')


def decompress_bytes(path):
    out = subprocess.run(['zstd', '-d', '-c', str(path)], capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode()[:200])
    return out.stdout


def compress_to(src_bytes, dest):
    proc = subprocess.run(['zstd', '-c', '-q', '-3'], input=src_bytes, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode()[:200])
    tmp = dest.parent / (dest.name + '.batchrename.tmp')
    tmp.write_bytes(proc.stdout)
    os.replace(tmp, dest)


def try_lock(session_dir):
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


def clean_name(raw, cap=16):
    text = CTRL.sub('', str(raw))
    text = re.sub(r'\s+', ' ', text).strip()
    text = re.sub(r'^[「『"\'""\-—:：、,，.。]+', '', text)
    text = re.sub(r'[」』"\'""\-—:：、,，.。]+$', '', text)
    text = text.replace('｜', '／').replace('|', '／')
    chars = list(text)
    return ''.join(chars[:cap]).strip()


def main(apply_mode):
    worklist = {item['id']: item for item in json.load(open('/tmp/batchrename-worklist.json'))}
    results = {}
    for n in range(1, 9):
        p = Path(f'/tmp/batchrename-result-{n}.json')
        if not p.exists():
            print(f'!! 缺少 {p}')
            return 1
        for entry in json.load(open(p)):
            results[entry['id']] = entry

    pending, skipped, invalid = [], [], []
    for sid, work in worklist.items():
        r = results.get(sid)
        if r is None or r.get('id') != sid:
            invalid.append({'id': sid, 'reason': 'missing-or-mismatched result'})
            continue
        if r.get('type') not in TYPES:
            invalid.append({'id': sid, 'reason': f"bad type {r.get('type')!r}"})
            continue
        name = clean_name(r.get('name', ''))
        if not name:
            invalid.append({'id': sid, 'reason': 'empty name'})
            continue
        pending.append({'id': sid, 'work': work, 'type': r['type'], 'name': name})

    print(f'校验通过 {len(pending)} / {len(worklist)};无效 {len(invalid)}')
    if invalid:
        Path('/tmp/batchrename-invalid.json').write_text(json.dumps(invalid, ensure_ascii=False, indent=1))

    BACKUP.mkdir(parents=True, exist_ok=True)
    done, failed = [], []
    for item in pending:
        sid, work = item['id'], item['work']
        sdir = Path(work['dir'])
        zpath = sdir / 'session.v4.jsonl.zstd'
        try:
            if try_lock(sdir):
                skipped.append({'id': sid, 'reason': 'locked-at-apply'})
                continue
            raw = decompress_bytes(zpath).decode('utf-8', 'replace')
            lines = [line for line in raw.splitlines() if line]
            header = json.loads(lines[0])
            if header.get('id') != sid:
                failed.append({'id': sid, 'reason': 'header id mismatch'})
                continue
            last = json.loads(lines[-1])
            last_seq = last.get('seq', 0)
            # 重查现标题:盘点后若有新 title 事件(如插件已命名/用户手动改),按规则重新裁决
            title_now, source_now = None, None
            for line in lines:
                event = json.loads(line)
                if event.get('type') == 'session/title':
                    title_now = (event.get('data') or {}).get('title')
                    source_now = ((event.get('data') or {}).get('source') or {}).get('kind')
            if title_now is not None and (RULED.match(title_now) or DOT.match(title_now) or source_now == 'user'):
                skipped.append({'id': sid, 'reason': f'now-titled: {title_now[:30]}'})
                continue
            title = f"{work['stamp']}｜{item['type']}｜{item['name']}"
            if len(title.encode('utf-8')) > 80:
                # 超字节预算时按码点截名(保尾部信息密度更高的完整名,从头截)
                title = f"{work['stamp']}｜{item['type']}｜" + item['name']
                budget = 80 - len((work['stamp'] + '｜' + item['type'] + '｜').encode('utf-8'))
                acc = ''
                for ch in item['name']:
                    if len((acc + ch).encode('utf-8')) > budget:
                        break
                    acc += ch
                title = f"{work['stamp']}｜{item['type']}｜{acc}"
            event = {
                'type': 'session/title',
                'seq': last_seq + 1,
                'time': int(time.time() * 1000),
                'data': {
                    'title': title,
                    'messageSeqs': [m['seq'] for m in work['messages']],
                    'source': {'kind': 'provider', 'provider': 'session-title-ruled'},
                },
            }
            (BACKUP / sdir.name).with_suffix('.zstd.bak').write_bytes(zpath.read_bytes())
            new_raw = raw if raw.endswith('\n') else raw + '\n'
            new_raw += json.dumps(event, ensure_ascii=False, separators=(',', ':')) + '\n'
            if apply_mode:
                compress_to(new_raw.encode('utf-8'), zpath)
            done.append({'id': sid, 'dir': sdir.name, 'title': title})
        except Exception as error:
            failed.append({'id': sid, 'reason': f'{type(error).__name__}: {error}'})

    print(f'{"已写入" if apply_mode else "DRY-RUN"} {len(done)};跳过 {len(skipped)};失败 {len(failed)}')
    Path(f'/tmp/batchrename-done-{"apply" if apply_mode else "dry"}.json').write_text(json.dumps(done, ensure_ascii=False, indent=1))
    if skipped:
        Path('/tmp/batchrename-skipped.json').write_text(json.dumps(skipped, ensure_ascii=False, indent=1))
    if failed:
        Path('/tmp/batchrename-failed.json').write_text(json.dumps(failed, ensure_ascii=False, indent=1))
    for row in done[:10]:
        print('  ', row['title'])
    return 0


if __name__ == '__main__':
    sys.exit(main('--apply' in sys.argv))
