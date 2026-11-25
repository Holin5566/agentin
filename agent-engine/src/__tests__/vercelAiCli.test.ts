import { defineAgent } from '../agents/manifest.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentEngine } from '../engine.js';
import { createMemoryStore } from '../artifacts/memory.js';
import { createVercelAiCli } from '../runtimes/vercelAiCli.js';
import type { Engine, RunEvent } from '../types.js';
import { startFakeOpenAi } from './helpers/fakeOpenAi.js';
import { RUNNER } from './helpers/runner.js';

/**
 * 「用 claude 跟用 vercel-ai 寫法一樣」:同一個 `createAgentEngine` / `runTake`,只換 runtime。
 * 這組測試走真的 engine(spawn、逾時、事件、產物),runner 連假 OpenAI server。
 */
const FIXTURE_ROOT = join(__dirname, 'fixture');

let engine: Engine | undefined;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await engine?.close();
  engine = undefined;
  for (const c of closers.splice(0)) await c();
});

async function setup(reply: Parameters<typeof startFakeOpenAi>[0], opts: Partial<Parameters<typeof createVercelAiCli>[0]> = {}) {
  const srv = await startFakeOpenAi(reply);
  closers.push(srv.close);
  const events: RunEvent[] = [];
  engine = createAgentEngine({
    root: FIXTURE_ROOT,
    runtime: createVercelAiCli({ baseUrl: srv.url, apiKey: 'sk-k', model: 'm', runnerPath: RUNNER, ...opts }),
    onEvent: (e) => events.push(e),
    log: () => {},
    artifacts: createMemoryStore(),
  });
  return { srv, events, engine };
}

describe('createVercelAiCli —— 能力預檢與執行參數分開', () => {
  it('runtime 沒有預設模型、模型由 TakeSpec.model 提供:能力預檢不能因為「缺模型」就把合法的 take 判成 capability 錯誤', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'ok' }));
    closers.push(srv.close);
    engine = createAgentEngine({
      root: FIXTURE_ROOT, runtime: createVercelAiCli({ baseUrl: srv.url, runnerPath: RUNNER }), // 沒有 model
      log: () => {}, artifacts: createMemoryStore(),
    });
    const r = await engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', model: 'from-take' });
    expect(r).toMatchObject({ status: 'ok', output: 'ok' });
    expect(srv.requests[0].body.model).toBe('from-take');
  });

  it('兩邊都沒有模型:仍是明確的 config 錯誤(執行參數缺漏),不是 capability', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'ok' }));
    closers.push(srv.close);
    engine = createAgentEngine({
      root: FIXTURE_ROOT, runtime: createVercelAiCli({ baseUrl: srv.url, runnerPath: RUNNER, modelHint: '請設模型' }),
      log: () => {}, artifacts: createMemoryStore(),
    });
    const r = await engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' }).then((x) => x, (e) => e);
    const err = r.error ?? r;
    expect(err.kind).toBe('config');
    expect(String(err.message)).toMatch(/沒有指定模型.*請設模型/);
  });
});

describe('createVercelAiCli —— 失敗分類(engine 轉成 EngineError 的欄位)', () => {
  it('模型端 401:EngineError.retryable = false、status = 401;宿主不必解析 stderr', async () => {
    const { engine } = await setup(() => ({ kind: 'http', status: 401, message: 'virtual key not found' }));
    const r = await engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ kind: 'runtime', retryable: false, status: 401 });
  });

  it('模型端 500 / 429:retryable = true,status 帶出來', async () => {
    for (const status of [500, 429]) {
      const { engine } = await setup(() => ({ kind: 'http', status, message: 'x' }));
      const r = await engine.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
      expect(r.error).toMatchObject({ kind: 'runtime', retryable: true, status });
    }
  });

  it('不是 HTTP 的失敗(沒有 status)仍標 retryable = true,而且沒有 status 欄位', async () => {
    const dead = createAgentEngine({ root: FIXTURE_ROOT, runtime: createVercelAiCli({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm', runnerPath: RUNNER }), log: () => {}, artifacts: createMemoryStore() });
    try {
      const r = await dead.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
      expect(r.error).toMatchObject({ kind: 'runtime', retryable: true });
      expect(r.error?.status).toBeUndefined();
    } finally { await dead.close(); }
  });

  it('runtime 沒有 classifyFailure(例如 claude 風格):欄位不存在 = 沒有意見,宿主照 kind 的預設處理', async () => {
    const e = createAgentEngine({
      root: FIXTURE_ROOT, log: () => {}, artifacts: createMemoryStore(),
      runtime: { name: 'plain', capabilities: { skills: false, nativeTools: true, filesystemPolicy: 'tool-list', maxSteps: false },
        command: () => ({ file: process.execPath, args: ['-e', 'process.stderr.write("boom"); process.exit(1)'] }) },
    });
    try {
      const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
      expect(r.error?.kind).toBe('runtime');
      expect(r.error?.retryable).toBeUndefined();
      expect(r.error?.status).toBeUndefined();
    } finally { await e.close(); }
  });
});

describe('createVercelAiCli —— 指令', () => {
  const rt = createVercelAiCli({ baseUrl: 'http://x/v1', apiKey: 'sk-secret', model: 'm', runnerPath: '/r.js', maxSteps: 7, maxToolResultChars: 99, maxContextChars: 5000 });

  it('形狀跟 claudeCli 一樣:spawn node 跑 runner,prompt 走 stdin', () => {
    const c = rt.command({ prompt: 'hello', mcpConfigPath: '/tmp/mcp.json' });
    expect(c.file).toBe(process.execPath);
    expect(c.stdin).toBe('hello');
    expect(c.args).toEqual(expect.arrayContaining(['/r.js', '--base-url', 'http://x/v1', '--model', 'm', '--mcp-config', '/tmp/mcp.json', '--max-steps', '7', '--max-tool-chars', '99', '--max-context-chars', '5000']));
  });

  it('model 可以省略(由 TakeSpec.model 帶);兩者都沒有 → spawn 前明確的 config 錯誤,帶宿主給的提示', () => {
    const bare = createVercelAiCli({ baseUrl: 'http://x/v1', runnerPath: '/r.js', modelHint: '請設 MODEL_X' });
    const c = bare.command({ prompt: 'p', model: 'from-take' });
    expect(c.args[c.args.indexOf('--model') + 1]).toBe('from-take');
    expect(() => bare.command({ prompt: 'p' })).toThrow(/沒有指定模型.*請設 MODEL_X/);
    expect(() => bare.command({ prompt: 'p' })).toThrowError(expect.objectContaining({ kind: 'config' }));
  });

  it('maxReasoningTokens → --max-reasoning-tokens;沒給就不帶旗標(由 runner 用預設值)', () => {
    expect(rt.command({ prompt: 'p' }).args).not.toContain('--max-reasoning-tokens');
    const c = createVercelAiCli({ baseUrl: 'http://x/v1', model: 'm', runnerPath: '/r.js', maxReasoningTokens: 2500 }).command({ prompt: 'p' });
    expect(c.args[c.args.indexOf('--max-reasoning-tokens') + 1]).toBe('2500');
  });

  it('金鑰走環境變數,不進 argv(`ps` 看得到)', () => {
    const c = rt.command({ prompt: 'x' });
    expect(c.env).toEqual({ VERCEL_AI_API_KEY: 'sk-secret' });
    expect(JSON.stringify(c.args)).not.toContain('sk-secret');
  });

  it('沒有 gateway 就不帶 --mcp-config;take 層的 model 蓋過預設', () => {
    const c = rt.command({ prompt: 'x', model: 'other' });
    expect(c.args).not.toContain('--mcp-config');
    expect(c.args[c.args.indexOf('--model') + 1]).toBe('other');
  });

  it('沒有原生工具 / skill;檔案系統限制靠 gateway 工具名單表達', () => {
    expect(rt.capabilities).toEqual({ skills: false, nativeTools: false, filesystemPolicy: 'tool-list', maxSteps: true });
  });
});

describe('createVercelAiCli —— 走 engine', () => {
  it('一次成功的 take:跟 claude 一樣的 TakeResult,事件有 text / usage,產物提交', async () => {
    const { engine: e, events } = await setup(() => ({ kind: 'text', text: 'Hello', usage: { prompt: 5, completion: 2 } }));
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', parseOutput: (raw) => raw.toUpperCase() });

    expect(r).toMatchObject({ status: 'ok', stopReason: 'end_turn', raw: 'Hello', output: 'HELLO', name: 'none' });
    expect(r.artifact).toMatchObject({ name: 'none', version: 'v1' });
    expect(r.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    const types = events.map((ev) => ev.type);
    expect(types[0]).toBe('started');
    expect(types).toContain('text');
    expect(types.at(-1)).toBe('completed');
  });

  it('TakeSpec.model 蓋過 createVercelAiCli 的預設模型', async () => {
    const { engine: e, srv } = await setup(() => ({ kind: 'text', text: 'x' }));
    await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', model: 'other-model' });
    expect(srv.requests[0].body.model).toBe('other-model');
  });

  it('HTTP 失敗 → 跟子程序故障同一種結果:status error、kind runtime(engine 可重試),訊息帶得出原因', async () => {
    const { engine: e } = await setup(() => ({ kind: 'http', status: 500, message: 'upstream boom' }));
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' });
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ kind: 'runtime' });
    expect(r.error!.message).toMatch(/HTTP 500|upstream boom/);
  });

  it('逾時:跟 claude 一樣由 engine 計時、終態 timeout', async () => {
    const { engine: e } = await setup(() => ({ kind: 'hang' }));
    const t0 = Date.now();
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', timeoutMs: 800 });
    expect(r.stopReason).toBe('timeout');
    expect(r.status).not.toBe('ok');
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it('取消:終態 cancelled', async () => {
    const { engine: e } = await setup(() => ({ kind: 'hang' }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 600);
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', signal: ac.signal });
    expect(r.stopReason).toBe('cancelled');
  });

  it('要寫檔案 / 要 shell 的 agent:能力協商擋下(沒有對應工具,不能「看起來成功」),不 spawn', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'x' }));
    closers.push(srv.close);
    for (const [id, capabilities, msg] of [
      ['w', { filesystem: 'workspace-write' }, /寫檔案/],
      ['sh', { shell: true }, /shell/],
    ] as const) {
      engine = createAgentEngine({
        root: FIXTURE_ROOT,
        runtime: createVercelAiCli({ baseUrl: srv.url, model: 'm', runnerPath: RUNNER }),
        agents: [{ id, tools: [], capabilities, flows: [], interactions: [] } as any],
        log: () => {},
        artifacts: createMemoryStore(),
      });
      const r = await engine.runTake({ agent: defineAgent({ id, tools: [], capabilities }), prompt: 'p' });
      expect(r.status).toBe('error');
      expect(r.error).toMatchObject({ kind: 'capability' });
      expect(r.error!.message).toMatch(msg);
      await engine.close();
    }
    expect(srv.requests).toHaveLength(0);
  });

  it('只宣告「全部禁用」(filesystem none / shell false)的純文字 agent:照常跑,不需要任何工具', async () => {
    const srv = await startFakeOpenAi(() => ({ kind: 'text', text: 'ok' }));
    closers.push(srv.close);
    engine = createAgentEngine({
      root: FIXTURE_ROOT,
      runtime: createVercelAiCli({ baseUrl: srv.url, model: 'm', runnerPath: RUNNER }),
      agents: [{ id: 'deny', tools: [], capabilities: { filesystem: 'none', shell: false }, flows: [], interactions: [] } as any],
      log: () => {},
      artifacts: createMemoryStore(),
    });
    const r = await engine.runTake({ agent: defineAgent({ id: 'deny', tools: [], capabilities: { filesystem: 'none', shell: false } }), prompt: 'p' });
    expect(r).toMatchObject({ status: 'ok', raw: 'ok' });
    expect(srv.requests[0].body.tools).toBeUndefined(); // 沒有 gateway、沒有檔案工具
  });
});
