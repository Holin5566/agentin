import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createVercelAiDecoder } from '../runtimes/vercelAi/decoder.js';
import { parseRunnerFailure } from '../runtimes/vercelAi/protocol.js';
import type { RuntimeEvent } from '../types.js';
import { startFakeOpenAi } from './helpers/fakeOpenAi.js';
import { RUNNER } from './helpers/runner.js';

/**
 * 真的 spawn runner(build 產物),連假 OpenAI server 與假 MCP server。
 * 驗 runner 這一層:讀設定 → 連 gateway → 跑 loop → 印協定行 → 收尾。
 *
 * 需要先 build(`npm test` 的 pretest 會做);直接跑 vitest 前要有 `dist/`。
 */
const FAKE_MCP = join(__dirname, 'fixture', 'fake-mcp-server.cjs');

beforeAll(() => {
  if (!existsSync(RUNNER)) throw new Error(`找不到 ${RUNNER} —— 先 build:./node_modules/.bin/tsc -b`);
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

function mcpConfig(): { path: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vai-runner-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'mcp.json');
  const pidFile = join(dir, 'gateway.pid');
  writeFileSync(path, JSON.stringify({
    mcpServers: { gateway: { command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_PIDFILE: pidFile } } },
  }));
  return { path, pidFile };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid: number, ms = 3000): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 50)); }
  return !alive(pid);
};

function runRunner(args: string[], o: { stdin?: string; env?: Record<string, string> } = {}) {
  const child = spawn(process.execPath, [RUNNER, ...args], { env: { ...process.env, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(o.stdin ?? 'hello');
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  cleanups.push(() => { child.kill('SIGKILL'); });
  return { child, exited, out: () => ({ stdout, stderr }) };
}

function decode(stdout: string): RuntimeEvent[] {
  const d = createVercelAiDecoder();
  return [...d.push(stdout), ...d.finish()];
}

describe('runner —— 端到端', () => {
  it('模型叫工具 → runner 透過 MCP 執行 → 結果回灌 → 收尾;事件完整', async () => {
    const srv = await startFakeOpenAi((n) =>
      n === 0 ? { kind: 'call', name: 'get_weather', args: '{"city":"Taipei"}' }
        : { kind: 'text', text: 'It is 27C', usage: { prompt: 9, completion: 3 } });
    cleanups.push(srv.close);

    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', mcpConfig().path], { stdin: '台北天氣?' });
    expect(await r.exited).toBe(0);

    const ev = decode(r.out().stdout);
    expect(ev.map((e) => e.type)).toEqual(['tool-start', 'tool-end', 'text', 'output', 'usage', 'stopped']);
    expect(ev[0]).toMatchObject({ type: 'tool-start', toolId: 'get_weather', input: { city: 'Taipei' } });
    expect(ev[1]).toMatchObject({ type: 'tool-end', ok: true, output: 'Taipei: 27C cloudy' });
    expect(ev.at(-3)).toEqual({ type: 'output', text: 'It is 27C' });
    expect(ev.at(-1)).toEqual({ type: 'stopped', reason: 'end_turn' });

    // 第一個請求帶了 gateway 的 tool schema 和 prompt;第二個請求帶了 MCP 工具的真實結果。
    expect(srv.requests).toHaveLength(2);
    expect(srv.requests[0].body.tools.map((t: any) => t.function.name).sort()).toEqual(['boom', 'get_weather']);
    expect(JSON.stringify(srv.requests[0].body.messages)).toContain('台北天氣?');
    expect(JSON.stringify(srv.requests[1].body.messages)).toContain('Taipei: 27C cloudy');
  });

  it('收到 tool call 之後串流才出錯:不當成失敗(call 照常執行、take 跑完),但 stderr 留一行,不靜靜吞掉', async () => {
    const srv = await startFakeOpenAi((n) =>
      n === 0 ? { kind: 'call-then-error', name: 'get_weather', args: '{"city":"Taipei"}', message: 'upstream reset' } : { kind: 'text', text: '好' });
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', mcpConfig().path]);
    expect(await r.exited, r.out().stderr).toBe(0);
    expect(r.out().stderr).toMatch(/串流在收到 1 個 tool call 之後出錯.*upstream reset/);
    const ev = decode(r.out().stdout);
    expect(ev.find((e) => e.type === 'tool-end')).toMatchObject({ ok: true, output: 'Taipei: 27C cloudy' });
    expect(ev.at(-1)).toEqual({ type: 'stopped', reason: 'end_turn' });
  });

  it('工具自己回報失敗(isError):tool-end ok=false,take 照常收尾', async () => {
    const srv = await startFakeOpenAi((n) => (n === 0 ? { kind: 'call', name: 'boom', args: '{}' } : { kind: 'text', text: '好' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', mcpConfig().path]);
    expect(await r.exited).toBe(0);
    const ev = decode(r.out().stdout);
    expect(ev.find((e) => e.type === 'tool-end')).toMatchObject({ ok: false, output: 'tool exploded' });
    expect(ev.at(-1)).toEqual({ type: 'stopped', reason: 'end_turn' });
  });

  it('模型叫了不存在的工具:gateway 拒絕的錯回給模型,不中斷', async () => {
    const srv = await startFakeOpenAi((n) => (n === 0 ? { kind: 'call', name: 'nope', args: '{}' } : { kind: 'text', text: '好' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', mcpConfig().path]);
    expect(await r.exited).toBe(0);
    const ev = decode(r.out().stdout);
    expect(ev.find((e) => e.type === 'tool-end')).toMatchObject({ ok: false });
    expect(ev.at(-1)).toEqual({ type: 'stopped', reason: 'end_turn' });
  });

  it('步數用完 → max_turn_requests', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'call', name: 'get_weather', args: '{"city":"T"}' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', mcpConfig().path, '--max-steps', '2']);
    expect(await r.exited).toBe(0);
    expect(decode(r.out().stdout).at(-1)).toEqual({ type: 'stopped', reason: 'max_turn_requests' });
    expect(srv.requests).toHaveLength(2);
  });

  it('沒有 --mcp-config(agent 沒宣告工具):純文字一輪', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'hi' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm']);
    expect(await r.exited).toBe(0);
    expect(decode(r.out().stdout).map((e) => e.type)).toEqual(['text', 'output', 'stopped']);
    expect(srv.requests[0].body.tools).toBeUndefined();
  });

  it('金鑰走環境變數 → Authorization header;不出現在 stdout', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'hi' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm'], { env: { VERCEL_AI_API_KEY: 'sk-secret-123' } });
    await r.exited;
    expect(srv.requests[0].headers.authorization).toBe('Bearer sk-secret-123');
    expect(r.out().stdout).not.toContain('sk-secret-123');
  });

  it('gateway 子程序拿不到 runner 的環境(金鑰與其他 secret),只拿到白名單與設定檔明列的值', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'hi' }));
    cleanups.push(srv.close);
    const cfg = mcpConfig();
    const envFile = join(cfg.path, '..', 'gateway-env.json');
    const parsed = JSON.parse(readFileSync(cfg.path, 'utf8'));
    parsed.mcpServers.gateway.env.FAKE_MCP_ENVFILE = envFile;
    parsed.mcpServers.gateway.env.GATEWAY_NEEDS = 'explicit-value';
    writeFileSync(cfg.path, JSON.stringify(parsed));

    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', cfg.path],
      { env: { VERCEL_AI_API_KEY: 'sk-secret-123', SOME_OTHER_SECRET: 'leak-me', SLACK_BOT_TOKEN: 'xoxb-leak' } });
    expect(await r.exited).toBe(0);

    const seen = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
    expect(seen.GATEWAY_NEEDS).toBe('explicit-value'); // 設定檔明列的照給
    expect(seen.PATH).toBeTruthy();                    // 能執行所需的基本變數還在
    expect(seen.VERCEL_AI_API_KEY).toBeUndefined();
    expect(seen.SOME_OTHER_SECRET).toBeUndefined();
    expect(seen.SLACK_BOT_TOKEN).toBeUndefined();
  });

  it('HTTP 失敗:退出碼非 0、錯誤訊息在 stderr、沒有 done 行(decoder 回 unknown,不當成功)', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'http', status: 500, message: 'boom' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm']);
    expect(await r.exited).toBe(1);
    expect(r.out().stderr).toMatch(/HTTP 500.*boom/);
    expect(decode(r.out().stdout)).toEqual([{ type: 'stopped', reason: 'unknown' }]);
    expect(srv.requests).toHaveLength(1);
  });

  it('失敗時 stderr 最後一行是失敗標記:401 不可重試、500 可重試、缺參數是 config', async () => {
    for (const [status, retryable] of [[401, false], [500, true]] as const) {
      const srv = await startFakeOpenAi(() => ({ kind: 'http', status, message: 'nope' }));
      cleanups.push(srv.close);
      const r = runRunner(['--base-url', srv.url, '--model', 'm']);
      expect(await r.exited).toBe(1);
      expect(parseRunnerFailure(r.out().stderr)).toEqual({ status, retryable });
      expect(r.out().stderr.trimEnd().split('\n').at(-1)).toMatch(/^@@runner-failure /);
    }
    const bad = runRunner(['--model', 'm']);
    expect(await bad.exited).toBe(1);
    expect(parseRunnerFailure(bad.out().stderr)).toEqual({ retryable: false });
  });

  it('模型講完卻沒有文字:補問一次,補問的回答就是輸出(請求裡帶著補問的話)', async () => {
    const srv = await startFakeOpenAi((n) => (n === 0 ? { kind: 'text', text: '' } : { kind: 'text', text: '補問後的答案' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm']);
    expect(await r.exited).toBe(0);
    expect(decode(r.out().stdout).find((e) => e.type === 'output')).toEqual({ type: 'output', text: '補問後的答案' });
    expect(srv.requests).toHaveLength(2);
    expect(JSON.stringify(srv.requests[1].body.messages)).toContain('answer in plain text now');
  });

  it('補問後仍沒有文字:不當成功 —— 退出碼 1、沒有 done、stderr 說明原因,標記為可重試', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: '' }));
    cleanups.push(srv.close);
    const r = runRunner(['--base-url', srv.url, '--model', 'm']);
    expect(await r.exited).toBe(1);
    expect(r.out().stderr).toContain('沒有給出任何文字回答');
    expect(parseRunnerFailure(r.out().stderr)).toEqual({ retryable: true });
    expect(decode(r.out().stdout)).toEqual([{ type: 'stopped', reason: 'unknown' }]);
    expect(srv.requests).toHaveLength(2); // 原本一次 + 補問一次,不再多
  });

  it('帶 system 訊息(今天的日期、規則),在使用者 prompt 之前', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'hi' }));
    cleanups.push(srv.close);
    const on = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', mcpConfig().path], { stdin: '你好' });
    expect(await on.exited).toBe(0);
    const msgs = srv.requests[0].body.messages;
    expect(msgs[0].role).toBe('system');
    const d = new Date();
    expect(msgs[0].content).toContain(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    expect(msgs[0].content).not.toContain('File tools'); // 假 gateway 沒有 fs 工具
    expect(msgs[1]).toMatchObject({ role: 'user', content: '你好' });
  });

  it('缺必要參數:明確報錯', async () => {
    const r = runRunner(['--model', 'm']);
    expect(await r.exited).toBe(1);
    expect(r.out().stderr).toContain('--base-url');
  });

  it('SIGTERM(engine 取消 / 逾時):很快退出,並收掉 gateway 子程序', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'hang' }));
    cleanups.push(srv.close);
    const cfg = mcpConfig();
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', cfg.path]);
    await new Promise((res) => setTimeout(res, 800)); // 等它連上 gateway、卡在模型
    const gatewayPid = Number(readFileSync(cfg.pidFile, 'utf8'));
    expect(alive(gatewayPid)).toBe(true);
    const t0 = Date.now();
    r.child.kill('SIGTERM');
    const code = await r.exited;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(code).not.toBe(0);
    expect(decode(r.out().stdout).at(-1)).toEqual({ type: 'stopped', reason: 'unknown' }); // 沒有 done
    expect(await waitGone(gatewayPid)).toBe(true); // gateway 子程序沒有留下來
  });

  it('正常收尾時 gateway 子程序也收掉', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'hi' }));
    cleanups.push(srv.close);
    const cfg = mcpConfig();
    const r = runRunner(['--base-url', srv.url, '--model', 'm', '--mcp-config', cfg.path]);
    expect(await r.exited).toBe(0);
    expect(await waitGone(Number(readFileSync(cfg.pidFile, 'utf8')))).toBe(true);
  });
});
