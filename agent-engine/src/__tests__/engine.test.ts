import { defineAgent } from '../agents/manifest.js';
import { getEventListeners } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentEngine } from '../engine.js';
import { createMemoryStore } from '../artifacts/memory.js';
import { codexCli } from '../runtimes/codexCli.js';
import type { Engine, RunEvent, RuntimeDecoder, RuntimeEvent, SpawnRuntime } from '../types.js';

/**
 * 整條組裝的測試:registry → gateway → exec → 事件 → 救援 → 產物。
 *
 * runtime 換成一小段 node 腳本,所以不必真的有 claude 也跑得起來,而且能精準
 * 製造逾時、截斷、壞輸出這些情境。
 */

// engine 有自己的 fixture,不借 mcp-hub 的 —— 那份刻意含一個用 in-memory 工具的
// agent,會被能力協商擋在門口(那正是它該做的事,見 gateway.test.ts)。
const FIXTURE_ROOT = join(__dirname, 'fixture');

/** 每行一個事件:`STOP:<reason>` 是終止原因,其餘是文字。 */
function lineDecoder(): RuntimeDecoder {
  let buffer = '';
  const parse = (line: string): RuntimeEvent[] => {
    if (!line) return [];
    if (line.startsWith('STOP:')) return [{ type: 'stopped' as const, reason: line.slice(5) as any }];
    if (line.startsWith('USAGE:')) return [{ type: 'usage' as const, mode: 'delta' as const, usage: { outputTokens: Number(line.slice(6)) } }];
    return [{ type: 'text' as const, chunk: line }];
  };
  return {
    push(chunk) { buffer += chunk; const l = buffer.split('\n'); buffer = l.pop() ?? ''; return l.flatMap(parse); },
    finish() { const t = buffer; buffer = ''; return parse(t); },
  };
}

/** 跑一段 node 腳本當 agent。 */
function scriptRuntime(src: string): SpawnRuntime {
  return {
    name: 'script',
    capabilities: { skills: true, nativeTools: true, filesystemPolicy: 'tool-list', maxSteps: false },
    command: () => ({ file: process.execPath, args: ['-e', src] }),
    createDecoder: lineDecoder,
  };
}

let engine: Engine | undefined;
afterEach(async () => { await engine?.close(); engine = undefined; });

/** fixture 的 `none` agent 宣告 `tools: []`,所以不會去開 gateway。 */
function make(src: string, extra: Parameters<typeof createAgentEngine>[0] = {}) {
  const events: RunEvent[] = [];
  engine = createAgentEngine({
    root: FIXTURE_ROOT,
    runtime: scriptRuntime(src),
    onEvent: (e) => events.push(e),
    log: () => {},
    // 預設的檔案 store 會寫進 FIXTURE_ROOT —— 測試不該把東西留在原始碼樹裡。
    // 要驗落地行為的是 fileStore.test.ts,那邊用暫存目錄。
    artifacts: createMemoryStore(),
    ...extra,
  });
  return { engine, events };
}

const write = (...lines: string[]) =>
  `const w=process.stdout;${lines.map((l) => `w.write(${JSON.stringify(l + '\n')});`).join('')}`;

describe('一次成功的 take', () => {
  it('回傳解析後的輸出,並提交產物', async () => {
    const store = createMemoryStore();
    const { engine: e } = make(write('hello', 'STOP:end_turn'), { artifacts: store });
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', parseOutput: (raw) => raw.toUpperCase() });

    expect(r).toMatchObject({ status: 'ok', stopReason: 'end_turn', raw: 'hello', output: 'HELLO', name: 'none' });
    expect(r.artifact).toMatchObject({ name: 'none', version: 'v1' });
    expect(await store.read(r.artifact!)).toBe('HELLO');
  });

  it('scope 讓同一個 engine 服務多個並行工作', async () => {
    const store = createMemoryStore();
    const { engine: e } = make(write('x', 'STOP:end_turn'), { artifacts: store });
    const a = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', scope: 'thread-1' });
    const b = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', scope: 'thread-2' });

    // 不同 scope 各自從 v1 開始,不會互相蓋掉。
    expect(a.artifact).toMatchObject({ scope: 'thread-1', version: 'v1' });
    expect(b.artifact).toMatchObject({ scope: 'thread-2', version: 'v1' });
  });

  it('同一個 scope 重跑產生新版本,舊的仍讀得到', async () => {
    const store = createMemoryStore();
    const { engine: e } = make(write('x', 'STOP:end_turn'), { artifacts: store });
    const first = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', scope: 's' });
    const second = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', scope: 's' });
    expect(second.artifact!.version).toBe('v2');
    expect(await store.read(first.artifact!)).toBe('x');
  });
});

describe('事件', () => {
  it('seq 嚴格遞增,started 開頭 completed 結尾', async () => {
    const { engine: e, events } = make(write('a', 'b', 'STOP:end_turn'));
    await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });

    expect(events.map((x) => x.seq)).toEqual([...events.keys()]);
    expect(events[0].type).toBe('started');
    expect(events.at(-1)!.type).toBe('completed');
    expect(events.filter((x) => x.type === 'completed')).toHaveLength(1);
  });

  it('completed 帶 engine 算好的 elapsedMs', async () => {
    // 宿主自己算會踩到「已完成的分支秒數還跟著 heartbeat 一直長」。
    const { engine: e, events } = make(write('x', 'STOP:end_turn'));
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    const done = events.at(-1) as any;
    expect(done.elapsedMs).toBe(r.elapsedMs);
    expect(done.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('usage 逐次累加', async () => {
    const { engine: e } = make(write('USAGE:10', 'USAGE:5', 'x', 'STOP:end_turn'));
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 15 });
  });

  it('宿主的 onEvent 丟例外不會毀掉 take', async () => {
    // 畫不出進度條不該讓一次已經跑完的查詢失敗。
    engine = createAgentEngine({
      root: FIXTURE_ROOT,
      runtime: scriptRuntime(write('x', 'STOP:end_turn')),
      onEvent: () => { throw new Error('progress renderer exploded'); },
      log: () => {},
      artifacts: createMemoryStore(),
    });
    const r = await engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r.status).toBe('ok');
  });
});

describe('被預算砍斷與救援', () => {
  it('max_tokens 是 truncated,不是 error', async () => {
    const { engine: e } = make(write('partial report', 'STOP:max_tokens'));
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r).toMatchObject({ status: 'truncated', stopReason: 'max_tokens', raw: 'partial report' });
  });

  it('salvage 救得回來時算成功,並標記 salvaged', async () => {
    const { engine: e } = make(write('<<<DONE>>>結論', 'STOP:max_tokens'));
    const r = await e.runTake({
      agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p',
      salvage: (raw) => raw.includes('<<<DONE>>>') ? raw.replace('<<<DONE>>>', '') : null,
    });
    expect(r).toMatchObject({ status: 'ok', salvaged: true, output: '結論' });
    // 救回來的才算成功,所以產物有落地。
    expect(r.artifact).toBeDefined();
  });

  it('救不回來就維持 truncated,而且不落地產物', async () => {
    // 髒內容一旦落地,下次 reuse 會撈到它 —— 比沒有產物難查得多。
    const { engine: e } = make(write('半句話就斷了', 'STOP:max_tokens'));
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', salvage: () => null });
    expect(r.status).toBe('truncated');
    expect(r.artifact).toBeUndefined();
  });

  it('逾時也走同一條救援路徑', async () => {
    const { engine: e } = make(`${write('救得回來')}setInterval(()=>{},1000)`);
    const r = await e.runTake({
      agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', timeoutMs: 400,
      salvage: (raw) => raw || null,
    });
    expect(r).toMatchObject({ status: 'ok', stopReason: 'timeout', salvaged: true });
  }, 15_000);
});

describe('失敗', () => {
  it('parseOutput 丟例外是 output 錯誤,不是 runtime', async () => {
    // 處置不同:子程序故障重試通常有用,輸出格式不對該先看 prompt 的硬規。
    const { engine: e } = make(write('not json', 'STOP:end_turn'));
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', parseOutput: () => { throw new Error('bad shape'); } });
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ kind: 'output' });
    expect(r.artifact).toBeUndefined();
  });

  it('缺 skill 直接收尾,不 spawn', async () => {
    const { engine: e } = make(write('SHOULD NOT RUN', 'STOP:end_turn'), {
      agents: [{ id: 'needs-skill', tools: [], skills: ['elk'], flows: [], interactions: [] }],
      checkSkill: () => ({ available: false, reason: '沒裝' }),
    });
    const r = await e.runTake({ agent: defineAgent({ id: 'needs-skill', tools: [], skills: ['elk'] }), prompt: 'p' });
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ kind: 'capability' });
    expect(r.raw).toBe('');   // 沒跑就沒有輸出
  });

  it('取消是 cancelled,不算失敗', async () => {
    const { engine: e } = make(`${write('partial')}setInterval(()=>{},1000)`);
    const ac = new AbortController();
    const run = e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await run;
    expect(r).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    expect(r.error).toBeUndefined();
  }, 15_000);

  it('不存在的 agent 在呼叫時就報 config,並列出有哪些', async () => {
    const { engine: e } = make(write('x', 'STOP:end_turn'));
    await expect(e.runTake({ agent: 'nope' as any, prompt: 'p' }))
      .rejects.toMatchObject({ kind: 'config' });
  });
});

describe('執行環境', () => {
  it('子程序在 root 跑(跟找 manifests 的是同一個地方),不看宿主從哪裡啟動', async () => {
    const { engine: e } = make(`process.stdout.write(process.cwd() + '\\n');process.stdout.write('STOP:end_turn\\n')`);
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(realpathSync(r.raw.trim())).toBe(realpathSync(FIXTURE_ROOT));
  });

  it('timeoutMs 從 startedAt 起算:take 之前已經花掉的時間要扣掉', async () => {
    const { engine: e } = make('setTimeout(() => {}, 10_000)');
    const t0 = Date.now();
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', timeoutMs: 1_500, startedAt: Date.now() - 1_300 });
    expect(r.stopReason).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(1_000); // 只剩 ~200ms 預算,不是整整 1.5 秒
  });

  it('沒成功的 take 丟掉 draft,不在 store 裡留一份沒人收的串流', async () => {
    const store = createMemoryStore();
    const { engine: e } = make(write('half an answer') + 'process.exit(1)', { artifacts: store });
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r.status).toBe('error');
    expect(await store.readPartial({ takeId: r.takeId })).toBeNull();
  });
});

describe('生命週期', () => {
  it('一個 engine 可以跑多次 take', async () => {
    const { engine: e } = make(write('x', 'STOP:end_turn'));
    const rs = await Promise.all([1, 2, 3].map(() => e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' })));
    expect(rs.every((r) => r.status === 'ok')).toBe(true);
    expect(new Set(rs.map((r) => r.takeId)).size).toBe(3);
  });

  it('同一個宿主 signal 跑很多次 take,listener 不會累積', async () => {
    const { engine: e } = make(write('x', 'STOP:end_turn'));
    const shared = new AbortController();
    for (let i = 0; i < 3; i++) await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', signal: shared.signal });
    expect(getEventListeners(shared.signal, 'abort')).toHaveLength(0);
  });

  it('close 之後不接受新的 take', async () => {
    const { engine: e } = make(write('x', 'STOP:end_turn'));
    await e.close();
    await expect(e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' })).rejects.toMatchObject({ kind: 'config' });
    engine = undefined;
  });
});

describe('輸出上限', () => {
  it('超量就砍掉,終態是 truncated 而不是 error', async () => {
    // 沒有這道防線,一個跑偏的 agent 可以把無上限的文字吃進記憶體並寫進產物。
    const { engine: e } = make(`
      const w = process.stdout;
      setInterval(() => w.write('x'.repeat(500) + '\\n'), 5);
    `);
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', maxOutputBytes: 2000 });
    expect(r).toMatchObject({ status: 'truncated', stopReason: 'max_output' });
  }, 20_000);

  it('已經收到的文字留著,可以 salvage', async () => {
    // 跟逾時同類:被切斷,但吐出來的東西可能有用。
    const { engine: e } = make(`
      const w = process.stdout;
      w.write('<<<DONE>>>結論在前面\\n');
      setInterval(() => w.write('x'.repeat(500) + '\\n'), 5);
    `);
    const r = await e.runTake({
      agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', maxOutputBytes: 2000,
      salvage: (raw) => raw.includes('<<<DONE>>>') ? '救回來了' : null,
    });
    expect(r).toMatchObject({ status: 'ok', salvaged: true, output: '救回來了' });
  }, 20_000);

  it('沒設上限時不干涉', async () => {
    const { engine: e } = make(write('x'.repeat(10_000), 'STOP:end_turn'));
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r.status).toBe('ok');
  });

  it('engine 層的預設值會生效', async () => {
    const { engine: e } = make(`
      const w = process.stdout;
      setInterval(() => w.write('y'.repeat(500) + '\\n'), 5);
    `, { defaults: { maxOutputBytes: 1500 } });
    expect((await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' })).stopReason).toBe('max_output');
  }, 20_000);
});

describe('失敗時的診斷', () => {
  it('stderr 帶進錯誤訊息 —— 不然只知道「子程序掛了」', async () => {
    const { engine: e } = make(`
      process.stderr.write('Error: missing credential ABC_TOKEN');
      process.exit(1);
    `);
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('missing credential ABC_TOKEN');
    expect(r.error?.message).toContain('exit 1');
  });

  it('額度用盡是 quota,不是可重試的 runtime', async () => {
    // 處置相反:一般故障重試通常有用,額度用盡重試只會一直撞到自己恢復為止。
    const { engine: e } = make(`
      process.stderr.write("You've hit your usage limit");
      process.exit(88);
    `);
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r.stopReason).toBe('quota');
    expect(r.error).toMatchObject({ kind: 'quota' });
  });

  it('取消途中子程序剛好以 88 退出 → 仍是 cancelled,不被誤標為不可重試的 quota', async () => {
    // quota(exit 88)不可重試、要等重置;取消可以。若一個被取消的 take 的子程序
    // 剛好在被 SIGTERM 時以 88 退出,宿主該看到的是 cancelled —— 別把它鎖成 quota。
    const { engine: e } = make(`process.on('SIGTERM',()=>process.exit(88));${write('partial')}setInterval(()=>{},1000)`);
    const ac = new AbortController();
    const run = e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await run;
    expect(r.stopReason).toBe('cancelled');
    expect(r.status).toBe('cancelled');
  }, 15_000);

  it('額度用盡不去 salvage —— 等重置才有意義', async () => {
    let salvageCalled = false;
    const { engine: e } = make(`process.stdout.write('partial\\n'); process.exit(88);`);
    const r = await e.runTake({
      agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p',
      salvage: () => { salvageCalled = true; return 'rescued'; },
    });
    expect(salvageCalled).toBe(false);
    expect(r.status).toBe('error');
  });
});

describe('close() 的收尾', () => {
  it('等進行中的 take,不是設個旗標就回去', async () => {
    // 不等的話宿主以為關乾淨了,實際上還有子程序在跑、還在寫產物。
    const { engine: e, events } = make(`
      process.stdout.write('started\\n');
      setTimeout(() => { process.stdout.write('STOP:end_turn\\n'); process.exit(0); }, 400);
    `);
    const run = e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });

    await new Promise((r) => setTimeout(r, 100));
    await e.close();

    // 斷言可觀測的事實而不是 promise 的 tick 順序:close() 回來的時候,
    // 那個 take 必須已經走到終態(completed 是 take 收尾時同步發出的)。
    expect(events.filter((x) => x.type === 'completed')).toHaveLength(1);
    await run;
    engine = undefined;
  }, 20_000);

  it('close() 會叫進行中的 take 停下來', async () => {
    const { engine: e } = make(`process.stdout.write('x\\n'); setInterval(()=>{},1000);`);
    const run = e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    await new Promise((r) => setTimeout(r, 200));
    await e.close();
    expect((await run).status).toBe('cancelled');
    engine = undefined;
  }, 20_000);
});

describe('測試本身的衛生', () => {
  it('不把產物寫進原始碼樹', () => {
    // 預設的檔案 store 會在 root 底下建 .agent-engine/。忘了傳 artifacts 的測試
    // 會靜靜污染 fixture 目錄 —— .gitignore 蓋掉它,所以 git status 也看不出來。
    expect(existsSync(join(FIXTURE_ROOT, '.agent-engine'))).toBe(false);
  });
});

describe('experimental runtime', () => {
  it('codex 預設拒絕,錯誤說得出原因 —— 不讓它跑出一個看起來成功的 take', () => {
    expect(() => createAgentEngine({ root: FIXTURE_ROOT, runtime: codexCli, artifacts: createMemoryStore() }))
      .toThrow(/runtime "codex-cli" 還不能用:.*decoder/);
  });

  it('開發 adapter 時可以明寫放行', async () => {
    const e = createAgentEngine({ root: FIXTURE_ROOT, runtime: codexCli, allowExperimentalRuntime: true,
      artifacts: createMemoryStore(), log: () => {} });
    await e.close();
  });
});

describe('宣告了但不支援的設定', () => {
  it('builtinTools 當場丟 config 錯誤,不讓宿主以為注入成功', () => {
    // gateway 是 claude -p 拉起的另一個程序,這裡的 JS 物件到不了模型手上。
    const tool = {
      name: 'echo', description: 'x', inputSchema: { type: 'object' as const, properties: {} },
      execute: async () => 'x',
    };
    expect(() => createAgentEngine({ builtinTools: [tool] }))
      .toThrow(expect.objectContaining({ kind: 'config', message: expect.stringMatching(/builtinTools 目前不支援/) }));
  });
});
