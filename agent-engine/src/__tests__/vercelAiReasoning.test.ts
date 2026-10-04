import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createVercelAiDecoder } from '../runtimes/vercelAi/decoder.js';
import { THINK_LESS_NUDGE } from '../runtimes/vercelAi/loop.js';
import type { RunnerLine } from '../runtimes/vercelAi/protocol.js';
import type { RuntimeEvent } from '../types.js';
import { startFakeOpenAi } from './helpers/fakeOpenAi.js';
import { RUNNER } from './helpers/runner.js';

/**
 * 思考超過預算(推理模型一路想、沒有答案)的處理。實測 Qwen 偶爾會想到 `maxTokens` 用完(約 45 秒、8000 token)。
 * loop 的單元測試在 `vercelAiLoop.test.ts`;這裡是 runner 端到端(真的斷線、事件、請求內容)。
 */

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });


describe('runner 端到端 —— 思考預算', () => {
  const decode = (stdout: string): RuntimeEvent[] => { const d = createVercelAiDecoder(); return [...d.push(stdout), ...d.finish()]; };
  const runRunner = (args: string[]) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end('hello');
    cleanups.push(() => { child.kill('SIGKILL'); });
    return { exited: new Promise<number | null>((r) => child.on('close', (c) => r(c))), out: () => ({ stdout, stderr }) };
  };

  it('第一次一直想 → 被中斷、重來(請求帶著提醒)→ 第二次有答案:take 成功,沒有等到「永遠不收尾」', async () => {
    const srv = await startFakeOpenAi((n) => (n === 0 ? { kind: 'think', chunks: 500, then: 'hang' } : { kind: 'text', text: '第二次的答案' }));
    cleanups.push(srv.close);
    const t0 = Date.now();
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--max-reasoning-tokens', '30']);
    expect(await r.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    const ev = decode(r.out().stdout);
    expect(ev.find((e) => e.type === 'output')).toEqual({ type: 'output', text: '第二次的答案' });
    expect(ev.at(-1)).toEqual({ type: 'stopped', reason: 'end_turn' });
    expect(srv.requests).toHaveLength(2);
    expect(JSON.stringify(srv.requests[1].body.messages)).toContain('spent too long thinking');
  });

  it('每次都想太久:最多打 2 次請求,以 reasoning_budget(truncated 類)收尾,不是成功也不是無限等', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'think', chunks: 500, then: 'hang' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--max-reasoning-tokens', '30']);
    expect(await r.exited).toBe(0);
    expect(decode(r.out().stdout).at(-1)).toEqual({ type: 'stopped', reason: 'reasoning_budget' });
    expect(srv.requests).toHaveLength(2);
  });

  it('--max-reasoning-tokens 0 = 不限:想很久也不中斷', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'think', chunks: 300, then: 'text', text: '想完了' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--max-reasoning-tokens', '0']);
    expect(await r.exited).toBe(0);
    expect(decode(r.out().stdout).find((e) => e.type === 'output')).toEqual({ type: 'output', text: '想完了' });
    expect(srv.requests).toHaveLength(1);
  });
});
