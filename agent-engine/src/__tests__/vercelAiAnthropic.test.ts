import { defineAgent } from '../agents/manifest.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentEngine } from '../engine.js';
import { createMemoryStore } from '../artifacts/memory.js';
import { createVercelAiCli } from '../runtimes/vercelAiCli.js';
import { createVercelAiDecoder } from '../runtimes/vercelAi/decoder.js';
import { runLoop, type LoopOptions } from '../runtimes/vercelAi/loop.js';
import { createVercelAiModel } from '../runtimes/vercelAi/model.js';
import type { RunnerLine } from '../runtimes/vercelAi/protocol.js';
import type { LoopToolSchema } from '../runtimes/vercelAi/types.js';
import { EngineError } from '../types.js';
import { startFakeAnthropic } from './helpers/fakeAnthropic.js';
import { RUNNER } from './helpers/runner.js';

/**
 * `provider: 'anthropic'`:同一支 runner / loop,模型端換成 Anthropic Messages API(`-s` 的 runtime)。
 * 用本機假的 Anthropic server(事件格式照真實 API),**沒有打真的 api.anthropic.com**。
 */
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const weather: LoopToolSchema = { name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
describe('loop(anthropic)', () => {
  const run = (url: string, over: Partial<LoopOptions> = {}, lines: RunnerLine[] = []) => runLoop({
    model: createVercelAiModel({ provider: 'anthropic', baseUrl: url, apiKey: 'sk-ant-test', model: 'claude-test' }),
    tools: { schemas: [], call: async () => ({ ok: true, text: '27C' }) }, prompt: 'hi', maxSteps: 5, maxToolResultChars: 1000,
    signal: new AbortController().signal, emit: l => lines.push(l), ...over });

  it('純文字:輸出與 usage;送出 x-api-key、/v1/messages、串流、max_tokens', async () => {
    const srv = await startFakeAnthropic(() => ({ kind: 'text', text: 'Hello', usage: { input: 11, output: 3 } }));
    closers.push(srv.close);
    expect(await run(srv.url, { maxTokens: 500 })).toMatchObject({ reason: 'end_turn', output: 'Hello', usage: { inputTokens: 11, outputTokens: 3 } });
    const r = srv.requests[0];
    expect(r.path).toBe('/v1/messages');
    expect(r.headers['x-api-key']).toBe('sk-ant-test');
    expect(r.headers['anthropic-version']).toBeTruthy();
    expect(r.headers.authorization).toBeUndefined();            // 不是 Bearer
    expect(r.body).toMatchObject({ model: 'claude-test', stream: true, max_tokens: 500 });
  });

  it('tool call:tool schema 是 Anthropic 格式(input_schema);結果回灌成 tool_use / tool_result 區塊', async () => {
    const srv = await startFakeAnthropic(n => n === 0 ? { kind: 'call', name: 'get_weather', args: '{"city":"Taipei"}' } : { kind: 'text', text: 'ok' });
    closers.push(srv.close);
    const lines: RunnerLine[] = [];
    await run(srv.url, { tools: { schemas: [weather], call: async () => ({ ok: true, text: '27C' }) } }, lines);
    expect(srv.requests[0].body.tools[0]).toMatchObject({ name: 'get_weather', input_schema: { type: 'object' } });
    const sent = JSON.stringify(srv.requests[1].body.messages);
    expect(sent).toContain('"type":"tool_use"');
    expect(sent).toContain('"type":"tool_result"');
    expect(sent).toContain('27C');
    expect(lines.find(l => l.t === 'tool-start')).toMatchObject({ name: 'get_weather', input: { city: 'Taipei' } });
  });

  it('金鑰無效(401)→ EngineError(runtime),訊息帶得出原因與 HTTP 狀態;不自己重試', async () => {
    const srv = await startFakeAnthropic(() => ({ kind: 'http', status: 401, message: 'invalid x-api-key' }));
    closers.push(srv.close);
    const p = run(srv.url);
    await expect(p).rejects.toBeInstanceOf(EngineError);
    await expect(p).rejects.toThrow(/401.*invalid x-api-key/);
    expect(srv.requests).toHaveLength(1);
  });

  it('openai-compat 沒給 baseUrl → config 錯誤(不會默默打到 anthropic 或空網址)', () => {
    expect(() => createVercelAiModel({ model: 'm' })).toThrow(expect.objectContaining({ kind: 'config' }));
  });
});

describe('createVercelAiCli(anthropic)', () => {
  it('指令:帶 --provider anthropic;baseUrl 省略就不帶 --base-url(用官方端點);金鑰走環境變數', () => {
    const c = createVercelAiCli({ provider: 'anthropic', apiKey: 'sk-ant-x', model: 'claude-x', runnerPath: '/r.js' }).command({ prompt: 'p' });
    expect(c.args).toEqual(expect.arrayContaining(['--provider', 'anthropic', '--model', 'claude-x']));
    expect(c.args).not.toContain('--base-url');
    expect(c.env).toEqual({ VERCEL_AI_API_KEY: 'sk-ant-x' });
    expect(JSON.stringify(c.args)).not.toContain('sk-ant-x');
  });
  it('預設仍是 openai-compat,而且一定要 baseUrl', () => {
    expect(() => createVercelAiCli({ model: 'm' })).toThrow(/需要 baseUrl/);
    const c = createVercelAiCli({ baseUrl: 'http://x/v1', model: 'm', runnerPath: '/r.js' }).command({ prompt: 'p' });
    expect(c.args).not.toContain('--provider');
    expect(c.args).toEqual(expect.arrayContaining(['--base-url', 'http://x/v1']));
  });
});

describe('runner / engine(anthropic,真的 spawn runner)', () => {
  it('runner:--provider anthropic 跑完一輪,輸出協定行;錯誤的 --provider 明確報錯', async () => {
    const srv = await startFakeAnthropic(() => ({ kind: 'text', text: 'pong', usage: { input: 4, output: 2 } }));
    closers.push(srv.close);
    const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const c = spawn(process.execPath, [RUNNER, ...args], { env: { ...process.env, VERCEL_AI_API_KEY: 'sk-ant-r' } });
      let out = '', err = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
      c.stdin.end('hi'); c.on('close', (code) => resolve({ code, out, err }));
    });
    const ok = await run(['--provider', 'anthropic', '--base-url', srv.url, '--model', 'claude-test']);
    expect(ok.code).toBe(0);
    const d = createVercelAiDecoder(); const ev = [...d.push(ok.out), ...d.finish()];
    expect(ev.at(-1)).toEqual({ type: 'stopped', reason: 'end_turn' });
    expect(ev).toContainEqual({ type: 'output', text: 'pong' });
    expect(srv.requests[0].headers['x-api-key']).toBe('sk-ant-r');
    const bad = await run(['--provider', 'nope', '--model', 'm']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('不認得的 --provider');
  });

  it('經 engine 的 runTake:跟其他 runtime 同一個 TakeResult', async () => {
    const srv = await startFakeAnthropic(() => ({ kind: 'text', text: 'Hello', usage: { input: 5, output: 2 } }));
    closers.push(srv.close);
    const engine = createAgentEngine({
      root: join(__dirname, 'fixture'),
      runtime: createVercelAiCli({ provider: 'anthropic', baseUrl: srv.url, apiKey: 'sk-ant-e', model: 'claude-test', runnerPath: RUNNER }),
      log: () => {}, artifacts: createMemoryStore(),
    });
    closers.push(() => engine.close());
    const r = await engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r).toMatchObject({ status: 'ok', stopReason: 'end_turn', raw: 'Hello' });
    expect(r.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });
});
