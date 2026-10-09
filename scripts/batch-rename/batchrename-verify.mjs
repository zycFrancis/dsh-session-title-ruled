// 批量补名终验:用宿主自己的 validateStoredEvents 逐个装载被改会话,
// 并复核追加事件的 seq 连续性与标题折叠结果(与 app 打开会话同路径)。
import { validateStoredEvents } from '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.dsh', 'sessions');
const RULED = /^\d{4}｜(研究|量化|开发|配置|排障|管理|创作|日常)｜/;
const done = JSON.parse(readFileSync('/tmp/batchrename-done-apply.json', 'utf8'));
const workdirs = new Map(JSON.parse(readFileSync('/tmp/batchrename-worklist.json', 'utf8')).map((item) => [item['id'], item['dir']]));
let pass = 0;
const failures = [];
for (const row of done) {
  const file = join(workdirs.get(row.id) ?? row.dir, 'session.v4.jsonl.zstd');
  try {
    const raw = execFileSync('zstd', ['-d', '-c', file], { maxBuffer: 1 << 28 }).toString('utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    const meta = JSON.parse(lines[0]);
    const events = lines.slice(1).map((line) => JSON.parse(line));
    validateStoredEvents(meta, events, `${row.dir}`);
    // seq 连续性(与宿主 assertContiguous 同判)
    for (let i = 0; i < events.length; i++) {
      if (events[i].seq !== i) throw new Error(`seq gap at ${i}: ${events[i].seq}`);
    }
    // 折叠最新标题
    const last = events.filter((e) => e.type === 'session/title').at(-1);
    if (!last || last.data.title !== row.title || !RULED.test(last.data.title)) {
      throw new Error(`fold mismatch: ${last?.data?.title} vs ${row.title}`);
    }
    pass++;
  } catch (error) {
    failures.push({ dir: row.dir, reason: String(error).slice(0, 200) });
  }
}
console.log(`宿主校验通过 ${pass}/${done.length};失败 ${failures.length}`);
if (failures.length) {
  writeFileSync('/tmp/batchrename-verify-failures.json', JSON.stringify(failures, null, 1));
  for (const f of failures.slice(0, 5)) console.log(f.dir, f.reason);
}
