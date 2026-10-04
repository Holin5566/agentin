import { defineAgent } from '../agents/manifest.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentEngine } from '../engine.js';
import { createMemoryStore } from '../artifacts/memory.js';
import { claudeCli, createClaudeCli } from '../runtimes/claudeCli.js';
import { codexCli, createCodexCli } from '../runtimes/codexCli.js';
import { childEnv } from '../run/exec.js';
import type { CommandContext, Engine, RunEvent, RuntimeDecoder, SpawnRuntime } from '../types.js';

/**
 * engine 開放給宿主組裝的能力:adapter 的具名選項,以及「一個 engine 服務很多並行請求」
 * 時每次 take 自己的事件與參數。生命週期(建幾個、何時關)是宿主的事,不在這裡測。
 */

const FIXTURE_ROOT = join(__dirname, 'fixture');

function textDecoder(): RuntimeDecoder {
  return { push: (chunk) => [{ type: 'text', chunk }], finish: () => [] };
}

/** 把 prompt 原樣印出;prompt 是 `wait` 就不結束。順便記下 engine 給的 CommandContext。 */
function echoRuntime(seen: CommandContext[] = []): SpawnRuntime {
  return {
    name: 'echo',
    capabilities: { skills: true, nativeTools: true, filesystemPolicy: 'tool-list', maxSteps: false },
    command: (ctx) => {
      seen.push(ctx);
      return {
        file: process.execPath,
        args: ['-e', `process.stdout.write(process.argv[1]); if (process.argv[1] === 'wait') setInterval(() => {}, 1000);`, ctx.prompt],
      };
    },
    createDecoder: textDecoder,
  };
}

let engine: Engine | undefined;
afterEach(async () => { await engine?.close(); engine = undefined; });

function make(extra: Parameters<typeof createAgentEngine>[0] = {}) {
  engine = createAgentEngine({
    root: FIXTURE_ROOT, runtime: echoRuntime(), log: () => {}, artifacts: createMemoryStore(), ...extra,
  });
  return engine;
}

describe('createClaudeCli 的具名選項', () => {
  const ctx: CommandContext = { prompt: 'p' };

  it('settings / skipPermissions 變成旗標;安全旗標照舊在', () => {
    const args = createClaudeCli({ settings: 's.json', skipPermissions: true }).command(ctx).args;
    expect(args).toEqual(expect.arrayContaining(['--settings', 's.json', '--dangerously-skip-permissions', '--strict-mcp-config']));
    expect(args.slice(-3)).toEqual(['--output-format', 'stream-json', '--verbose']);
  });

  it('沒給選項就不加 —— 預設 claudeCli 不帶 settings / skip-permissions', () => {
    const args = claudeCli.command(ctx).args;
    expect(args).not.toContain('--settings');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('slash command 跟著 agent 的 skills 走:沒宣告就關,宣告了才開', () => {
    expect(claudeCli.command({ prompt: 'p' }).args).toContain('--disable-slash-commands');
    expect(claudeCli.command({ prompt: 'p', skills: [] }).args).toContain('--disable-slash-commands');
    expect(claudeCli.command({ prompt: 'p', skills: ['elk'] }).args).not.toContain('--disable-slash-commands');
  });

  it('unsetEnv 變成 env: undefined(交給 engine 從子程序環境拿掉)', () => {
    expect(createClaudeCli({ unsetEnv: ['ANTHROPIC_API_KEY'] }).command(ctx).env).toEqual({ ANTHROPIC_API_KEY: undefined });
    expect(claudeCli.command(ctx)).not.toHaveProperty('env');
  });

  it('env 疊進子程序環境;同一個 key 也在 unsetEnv 時拿掉優先', () => {
    expect(createClaudeCli({ env: { MCP_TIMEOUT: '180000' } }).command(ctx).env).toEqual({ MCP_TIMEOUT: '180000' });
    expect(createClaudeCli({ env: { MCP_TIMEOUT: '1', ANTHROPIC_API_KEY: 'leak' }, unsetEnv: ['ANTHROPIC_API_KEY'] }).command(ctx).env)
      .toEqual({ MCP_TIMEOUT: '1', ANTHROPIC_API_KEY: undefined });
  });
});

describe('createCodexCli 的具名選項', () => {
  const ctx: CommandContext = { prompt: 'p' };

  it('profile → -p;unsetEnv → env: undefined;沒給就不加', () => {
    const cmd = createCodexCli({ profile: 'bot', unsetEnv: ['OPENAI_API_KEY'] }).command(ctx);
    expect(cmd.args).toEqual(expect.arrayContaining(['-p', 'bot', '--json']));
    expect(cmd.env).toEqual({ OPENAI_API_KEY: undefined });
    expect(codexCli.command(ctx).args).not.toContain('-p');
    expect(codexCli.command(ctx)).not.toHaveProperty('env');
  });

  it('env 與 claude 對稱:疊進子程序環境,unsetEnv 優先', () => {
    expect(createCodexCli({ env: { RUST_LOG: 'warn', OPENAI_API_KEY: 'leak' }, unsetEnv: ['OPENAI_API_KEY'] }).command(ctx).env)
      .toEqual({ RUST_LOG: 'warn', OPENAI_API_KEY: undefined });
  });

  it('跟預設 adapter 同樣是 experimental', () => {
    expect(createCodexCli({ profile: 'bot' }).experimental).toBe(codexCli.experimental);
  });
});

describe('env 移除', () => {
  it('env 值為 undefined = 從子程序環境拿掉(例如不讓 ANTHROPIC_API_KEY 漏進 claude -p)', () => {
    process.env.__ENGINE_TEST_SECRET = 'leak';
    try {
      const env = childEnv({ __ENGINE_TEST_SECRET: undefined, ADDED: '1' });
      expect(env).not.toHaveProperty('__ENGINE_TEST_SECRET');
      expect(env.ADDED).toBe('1');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.__ENGINE_TEST_SECRET;
    }
  });

  it('拿掉的變數,子程序真的看不到', async () => {
    process.env.__ENGINE_TEST_SECRET = 'leak';
    try {
      const runtime: SpawnRuntime = {
        ...echoRuntime(),
        command: () => ({
          file: process.execPath,
          args: ['-e', `process.stdout.write(process.env.__ENGINE_TEST_SECRET ?? 'gone')`],
          env: { __ENGINE_TEST_SECRET: undefined },
        }),
      };
      const e = make({ runtime });
      expect((await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' })).output).toBe('gone');
    } finally {
      delete process.env.__ENGINE_TEST_SECRET;
    }
  });
});

describe('skills 傳給 runtime', () => {
  it('agent 宣告的 skills 出現在 CommandContext;沒宣告就不帶', async () => {
    const seen: CommandContext[] = [];
    const e = make({
      runtime: echoRuntime(seen),
      agents: [{ id: 'skilled', tools: [], skills: ['elk'], flows: [], interactions: [] }],
      checkSkill: () => ({ available: true, reason: '' }),
    });
    // registry 建立時會先用空 prompt 探測 runtime 的指令,那幾次不算。
    const takes = () => seen.filter((c) => c.prompt);
    await e.runTake({ agent: defineAgent({ id: 'skilled', tools: [], skills: ['elk'] }), prompt: 'skilled' });
    await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'none' });
    const [skilled, none] = takes();
    expect(skilled.skills).toEqual(['elk']);
    expect(none).not.toHaveProperty('skills');
  });
});

describe('take 層的 onEvent', () => {
  it('並行 take 各自只收到自己的事件;engine 層收到全部', async () => {
    const all: RunEvent[] = [];
    const e = make({ onEvent: (ev) => { all.push(ev); } });
    const mine: RunEvent[][] = [[], []];
    const results = await Promise.all(['a', 'b'].map((prompt, i) =>
      e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt, onEvent: (ev) => { mine[i].push(ev); } })));

    for (const [i, r] of results.entries()) {
      expect(r.output).toBe(['a', 'b'][i]);
      expect(new Set(mine[i].map((ev) => ev.takeId))).toEqual(new Set([r.takeId]));
      expect(mine[i].map((ev) => ev.seq)).toEqual([...mine[i].keys()]);
      expect(mine[i].at(-1)?.type).toBe('completed');
    }
    expect(all).toHaveLength(mine[0].length + mine[1].length);
  });

  it('不 await:永遠不 resolve 的 async callback 拖不住 take', async () => {
    const e = make();
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', onEvent: () => new Promise<void>(() => {}) as any });
    expect(r.status).toBe('ok');
  });

  it('async callback 的 rejection 被接住並記 log,不影響 take,也不影響另一個 sink', async () => {
    const logs: string[] = [];
    const engineLevel: RunEvent[] = [];
    const e = make({ log: (l) => { logs.push(l); }, onEvent: (ev) => { engineLevel.push(ev); } });
    const r = await e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p', onEvent: (async () => { throw new Error('take 層壞了'); }) as any });
    await new Promise((res) => setImmediate(res)); // 讓 rejection 的 catch 跑完
    expect(r.status).toBe('ok');
    expect(engineLevel.at(-1)?.type).toBe('completed');
    expect(logs.some((l) => l.includes('take 層壞了'))).toBe(true);
  });

  it('一個 take 取消不影響同 engine 上的另一個', async () => {
    const e = make();
    const abort = new AbortController();
    const [cancelled, ok] = await Promise.all([
      e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'wait', signal: abort.signal, onEvent: (ev) => { if (ev.type === 'text') abort.abort(); } }),
      e.runTake({ agent: defineAgent({ id: 'none', tools: [] }), prompt: 'p' }),
    ]);
    expect(cancelled.status).toBe('cancelled');
    expect(ok.status).toBe('ok');
  }, 15_000);
});

describe('code-defined agents', () => {
  it('runs an injected definition without a disk manifest and keeps its stable ID', async () => {
    const agent = defineAgent({ id: 'defined-chat', tools: [], capabilities: { filesystem: 'none', shell: false } });
    const result = await make().runTake({ agent, prompt: 'hello' });
    expect(result.agent).toBe('defined-chat');
    expect(result.output).toBe('hello');
  });

  it('validates injected tools and cannot bypass the engine agent allowlist', async () => {
    const agent = defineAgent({ id: 'defined-chat', tools: ['missing-tool'] });
    await expect(make().runTake({ agent, prompt: 'hello' })).rejects.toMatchObject({ kind: 'config' });
    await expect(make({ agentIds: ['sample'] }).runTake({ agent, prompt: 'hello' })).rejects.toMatchObject({ kind: 'config' });
  });

  it('keeps capability negotiation and rejects invalid definition fields', async () => {
    const runtime = echoRuntime();
    runtime.capabilities.skills = false;
    const result = await make({ runtime }).runTake({ agent: defineAgent({ id: 'needs-skill', skills: ['elk'] }), prompt: 'hello' });
    expect(result.error?.kind).toBe('capability');
    expect(() => defineAgent({ id: 'bad', capabilities: { filesystem: 'invalid' } } as any)).toThrow();
  });
});
