import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { execRuntime } from '../run/exec.js';
import { EngineError, type RuntimeDecoder, type RuntimeEvent } from '../types.js';

/** 跑一小段 node 程式,省得為每個情境放一個 fixture 檔。 */
const node = (src: string) => ({ file: process.execPath, args: ['-e', src] });

/** 把每一行當一個事件解;第二行起累積在緩衝區,驗 finish() 有沒有排空。 */
function lineDecoder(): RuntimeDecoder {
  let buffer = '';
  const parse = (line: string): RuntimeEvent[] => {
    if (!line) return [];
    if (line.startsWith('STOP:')) return [{ type: 'stopped', reason: line.slice(5) as any }];
    return [{ type: 'text', chunk: line }];
  };
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      return lines.flatMap(parse);
    },
    finish() {
      const tail = buffer;
      buffer = '';
      return parse(tail);
    },
  };
}

/** 把 `text` 的 UTF-8 位元組從第 `cut` 個切開,分兩次寫到 fd,中間隔 50ms,確保分成兩個 chunk 送達。 */
const splitWrite = (stream: 'stdout' | 'stderr', text: string, cut: number) => node(
  `const b = Buffer.from(${JSON.stringify(text)}); process.${stream}.write(b.subarray(0, ${cut})); setTimeout(() => process.${stream}.write(b.subarray(${cut})), 50);`,
);

describe('UTF-8 跨 chunk', () => {
  // 「中」是 3 個位元組,從第 2 個切開 = 一個字元被拆到兩個 chunk。
  it('沒有 decoder:被拆開的中文字元要完整拼回', async () => {
    const r = await execRuntime({ command: splitWrite('stdout', '中文', 2) });
    expect(r.text).toBe('中文');
  });

  it('有 decoder(JSONL):被拆開的字元不能變成 �', async () => {
    const r = await execRuntime({ command: splitWrite('stdout', '中文\n', 2), decoder: lineDecoder() });
    expect(r.text).toBe('中文');
  });

  it('stderr 也一樣', async () => {
    const r = await execRuntime({ command: splitWrite('stderr', '錯誤', 1) });
    expect(r.stderr).toBe('錯誤');
  });
});

describe('基本執行', () => {
  it('沒有 decoder 時整段 stdout 就是輸出', async () => {
    const r = await execRuntime({ command: node('process.stdout.write("hello")') });
    expect(r).toMatchObject({ text: 'hello', stopReason: 'end_turn', exitCode: 0, cleanup: 'complete' });
  });

  it('非 0 退出碼在沒有其他線索時是 unknown,不是 end_turn', async () => {
    const r = await execRuntime({ command: node('process.exit(3)') });
    expect(r.stopReason).toBe('unknown');
    expect(r.exitCode).toBe(3);
  });

  it('stderr 留下來給診斷,但不進輸出', async () => {
    const r = await execRuntime({ command: node('process.stderr.write("boom"); process.exit(1)') });
    expect(r.stderr).toContain('boom');
    expect(r.text).toBe('');
  });

  it('執行檔不存在是 runtime 錯誤,訊息指得出是哪個指令', async () => {
    await expect(execRuntime({ command: { file: 'definitely-not-a-real-binary-xyz', args: [] } }))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'runtime' });
  });
});

describe('decoder', () => {
  it('跨 chunk 被切斷的一行仍然解得出來', async () => {
    // 這是無狀態 parse(chunk) 做不到的事:JSONL 一定會在某次 chunk 邊界被切開。
    const src = 'const w=process.stdout;w.write("aa");w.write("bb\\ncc");w.write("dd\\n")';
    const r = await execRuntime({ command: node(src), decoder: lineDecoder() });
    expect(r.text).toBe('aabbccdd');
  });

  it('finish() 排空沒有換行結尾的尾巴', async () => {
    // 少了 finish(),最後一行會被默默吞掉 —— 而那常常正是結論所在。
    const r = await execRuntime({ command: node('process.stdout.write("no trailing newline")'), decoder: lineDecoder() });
    expect(r.text).toBe('no trailing newline');
  });

  it('decoder 講的終止原因優先於退出碼', async () => {
    const r = await execRuntime({
      command: node('process.stdout.write("STOP:max_tokens\\n")'),
      decoder: lineDecoder(),
    });
    expect(r.stopReason).toBe('max_tokens');
  });

  it('事件依到達順序送出,不並行', async () => {
    // 落盤順序要跟到達順序一致,否則 partial 會亂序。
    const seen: string[] = [];
    await execRuntime({
      command: node('const w=process.stdout;w.write("1\\n2\\n3\\n")'),
      decoder: lineDecoder(),
      onEvent: async (e) => {
        if (e.type !== 'text') return;
        // 故意讓第一個慢,若沒有序列化就會被後面的插隊。
        await new Promise((r) => setTimeout(r, e.chunk === '1' ? 30 : 0));
        seen.push(e.chunk);
      },
    });
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('onEvent 丟出例外會讓整次執行失敗,不被吞掉', async () => {
    // 落盤失敗卻回報成功,會產生一個「宿主以為有證據、其實沒有」的結果。
    await expect(execRuntime({
      command: node('process.stdout.write("x\\n")'),
      decoder: lineDecoder(),
      onEvent: () => { throw new EngineError('runtime', 'disk full'); },
    })).rejects.toThrow(/disk full/);
  });
});

describe('取消與逾時', () => {
  it('已經 aborted 的 signal 不會 spawn 任何東西', async () => {
    const r = await execRuntime({
      command: node('process.stdout.write("should not run")'),
      signal: AbortSignal.abort(),
    });
    expect(r).toMatchObject({ stopReason: 'cancelled', text: '', cleanup: 'complete' });
  });

  it('取消時回 cancelled,而且保留已經吐出來的文字', async () => {
    // partial 要留著 —— salvage 靠的就是它。
    const ac = new AbortController();
    const src = 'process.stdout.write("partial\\n"); setInterval(()=>{},1000)';
    const run = execRuntime({ command: node(src), decoder: lineDecoder(), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await run;
    expect(r.stopReason).toBe('cancelled');
    expect(r.text).toBe('partial');
  }, 15_000);

  it('逾時回 timeout,跟取消分得開', async () => {
    const r = await execRuntime({
      command: node('setInterval(()=>{},1000)'),
      timeoutMs: 300,
    });
    expect(r.stopReason).toBe('timeout');
  }, 15_000);

  it('取消優先於子程序自己的退出碼', async () => {
    // 被 SIGTERM 殺掉的程序常常回一個沒意義的碼,不能拿它當終止原因。
    const ac = new AbortController();
    const run = execRuntime({ command: node('setInterval(()=>{},1000)'), signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    expect((await run).stopReason).toBe('cancelled');
  }, 15_000);
});

/** 帶 tag 的孫程序還有幾個活著(tag 走 env 傳給子程序、再放進孫程序 argv)。 */
const aliveWith = (tag: string) => spawnSync('/bin/sh', ['-c', `ps -eo args | grep -F '${tag}' | grep -v grep || true`], { encoding: 'utf8' })
  .stdout.split('\n').filter((l) => l.trim()).length;
const waitGone = async (tag: string) => {
  const deadline = Date.now() + 8_000;
  while (aliveWith(tag) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return aliveWith(tag);
};

describe('process group', () => {
  it('onEvent 失敗(落盤失敗)會殺掉整個 group 才回報失敗,不留子程序在背景跑', async () => {
    const tag = `exec-sinkfail-${randomUUID()}`;
    const src = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', process.env.GRANDCHILD_TAG], { stdio: 'ignore' });
      setTimeout(() => process.stdout.write('x\\n'), 300);
      setInterval(() => {}, 1000);
    `;
    let calls = 0;
    const run = execRuntime({
      command: { ...node(src), env: { GRANDCHILD_TAG: tag } },
      decoder: lineDecoder(),
      onEvent: () => { calls++; throw new EngineError('runtime', 'disk full'); },
    });
    await expect(run).rejects.toThrow(/disk full/);
    expect(await waitGone(tag)).toBe(0);
    expect(calls).toBe(1);
  }, 20_000);

  it('onEvent 失敗的 reject 帶著 reapGroup 算出的 cleanup(不是丟掉讓 engine 預設 complete)', async () => {
    // The fix: settle() routes the reaped cleanup through fail(), so the rejection
    // carries it. Here the grandchild is in-group and reapable, so the honest
    // value is 'complete' — the point is the value is PRESENT on the rejection.
    // Pre-fix fail() attached nothing, and engine.ts then blind-defaulted every
    // failure's cleanup to 'complete', including the genuinely 'unconfirmed' ones.
    // The same fail() path carries 'unconfirmed' when reapGroup can't confirm —
    // the pipe-holding reap test above proves reapGroup yields that value.
    const tag = `exec-sinkfail-cleanup-${randomUUID()}`;
    const src = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', process.env.GRANDCHILD_TAG], { stdio: 'ignore' });
      setTimeout(() => process.stdout.write('x\\n'), 300);
      setInterval(() => {}, 1000);
    `;
    const run = execRuntime({
      command: { ...node(src), env: { GRANDCHILD_TAG: tag } },
      decoder: lineDecoder(),
      onEvent: () => { throw new EngineError('runtime', 'disk full'); },
    });
    const err = await run.then(() => null, (e: any) => e);
    expect(err).toMatchObject({ message: expect.stringContaining('disk full') });
    expect((err as { cleanup?: string }).cleanup).toBe('complete'); // present + honest (in-group grandchild reaped)
    expect(await waitGone(tag)).toBe(0);
  }, 20_000);

  it('等管線排空才結算:孫程序在子程序 exit 之後才寫的尾段不會漏', async () => {
    const src = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write(\"tail\\\\n\"),300)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      process.stdout.write('head\\n');
      process.exit(0);
    `;
    const r = await execRuntime({ command: node(src), decoder: lineDecoder() });
    expect(r.text).toBe('headtail');
    expect(r.cleanup).toBe('complete');
  }, 15_000);

  it('孫程序一直握著管線 → exit 後期限到就殺掉殘留 group,回報 unconfirmed 而不是卡住', async () => {
    const tag = `exec-holdpipe-${randomUUID()}`;
    const src = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', process.env.GRANDCHILD_TAG], { stdio: ['ignore', 'inherit', 'inherit'] });
      process.stdout.write('done\\n');
      process.exit(0);
    `;
    const r = await execRuntime({ command: { ...node(src), env: { GRANDCHILD_TAG: tag } }, decoder: lineDecoder(), exitGraceMs: 500 });
    expect(r).toMatchObject({ text: 'done', stopReason: 'end_turn', cleanup: 'unconfirmed', exitCode: 0 });
    expect(await waitGone(tag)).toBe(0);
  }, 20_000);

  it('逾時:子程序先退出、孫程序忽略 SIGTERM 且沒握管線 → 結算前要升級 SIGKILL 清掉,不能報 complete 卻留著它', async () => {
    const tag = `exec-ignoreterm-${randomUUID()}`;
    const src = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(()=>{},1000)', process.env.GRANDCHILD_TAG], { stdio: 'ignore' });
      process.stdout.write('spawned\\n');
      setInterval(() => {}, 1000);
    `;
    const r = await execRuntime({
      command: { ...node(src), env: { GRANDCHILD_TAG: tag } },
      decoder: lineDecoder(), timeoutMs: 500, killGraceMs: 300, exitGraceMs: 1_000,
    });
    expect(r.stopReason).toBe('timeout');
    // 結算的那一刻就要乾淨(不是「過一陣子會消失」)
    expect(aliveWith(tag)).toBe(0);
    expect(r.cleanup).toBe('complete');
  }, 20_000);

  it('正常結束時殘留的孫程序也收掉:take 結束後不該有東西在背景跑', async () => {
    const tag = `exec-leftover-${randomUUID()}`;
    const src = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', process.env.GRANDCHILD_TAG], { stdio: 'ignore' });
      process.stdout.write('done\\n');
      setTimeout(() => process.exit(0), 200);
    `;
    const r = await execRuntime({ command: { ...node(src), env: { GRANDCHILD_TAG: tag } }, decoder: lineDecoder(), killGraceMs: 300 });
    expect(r).toMatchObject({ text: 'done', stopReason: 'end_turn', cleanup: 'complete', exitCode: 0 });
    expect(aliveWith(tag)).toBe(0);
  }, 20_000);

  it('取消會連孫程序一起殺掉', async () => {
    // 這是整個 exec 層最重要的一條:claude -p 會再 spawn MCP server,
    // 只 kill 直接子程序會留下孫程序繼續跑,而且還握著管線。
    const tag = `exec-grandchild-${randomUUID()}`;
    // tag 走 env 不走 argv —— 直接寫進原始碼的話,`ps` 會連子程序自己的
    // `node -e <src>` 一起數進去,分不出殺掉的是哪一層。
    const src = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', process.env.GRANDCHILD_TAG], { stdio: 'ignore' });
      process.stdout.write('spawned\\n');
      setInterval(() => {}, 1000);
    `;
    const alive = () => spawnSync('/bin/sh', ['-c', `ps -eo args | grep -F '${tag}' | grep -v grep || true`], { encoding: 'utf8' })
      .stdout.split('\n').filter((l) => l.trim()).length;

    const ac = new AbortController();
    const run = execRuntime({
      command: { ...node(src), env: { GRANDCHILD_TAG: tag } },
      decoder: lineDecoder(),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 500));
    // 先確認孫程序真的起來了,否則下面的斷言會空過。
    expect(alive()).toBe(1);

    ac.abort();
    await run;

    const deadline = Date.now() + 8_000;
    while (alive() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(0);
  }, 20_000);
});

describe('stdin', () => {
  it('大 prompt 走 stdin 完整送達(argv 會超過長度上限)', async () => {
    const prompt = `- 開頭是 dash 的清單\n${'證據'.repeat(300_000)}`; // ~1.8 MB
    const r = await execRuntime({
      command: { ...node(`let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(require('crypto').createHash('sha256').update(s).digest('hex')))`), stdin: prompt },
    });
    expect(r.stopReason).toBe('end_turn');
    expect(r.text).toBe(createHash('sha256').update(prompt).digest('hex'));
  });

  it('子程序不讀 stdin 就退出:EPIPE 不會變成未捕捉的例外,照常結算', async () => {
    const r = await execRuntime({ command: { ...node('process.exit(0)'), stdin: 'x'.repeat(5_000_000) } });
    expect(r.exitCode).toBe(0);
  });

  it('沒給 stdin 時子程序立刻讀到 EOF,不會卡住等輸入', async () => {
    const r = await execRuntime({
      command: node(`process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.stdout.write('EOF'))`),
      timeoutMs: 5_000,
    });
    expect(r.text).toBe('EOF');
  });
});
