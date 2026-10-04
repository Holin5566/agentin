import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { claudeRuntime, createAgentin, createMemoryStore, defineAgent } from '../../src/index.js';
import type { RunEvent, SpawnRuntime } from '../../src/index.js';

function runtime(name = 'echo', script = "process.stdin.pipe(process.stdout)"): SpawnRuntime {
  return {
    name, capabilities: { skills: false, nativeTools: false, filesystemPolicy: 'tool-list', maxSteps: false },
    command: vi.fn(({ prompt }) => ({ file: process.execPath, args: ['-e', script], stdin: prompt })),
  };
}
const assistant = () => defineAgent({ id: 'assistant', instructions: 'Speak Chinese.' });
function setup(adapter = runtime()) {
  return createAgentin({ agents: [assistant()], runtimes: { local: adapter }, defaultRuntime: 'local', artifacts: createMemoryStore() });
}

describe('SDK integration', () => {
  it('uses instructions, delegates events, parses output and commits an artifact', async () => {
    const store = createMemoryStore();
    const global: RunEvent[] = [], local: RunEvent[] = [];
    const app = createAgentin({ agents: [assistant()], runtimes: { local: runtime() }, defaultRuntime: 'local', artifacts: store, onEvent: event => global.push(event) });
    try {
      const result = await app.run({ agent: 'assistant', input: 'Hello', onEvent: event => local.push(event), parseOutput: text => text.toUpperCase() });
      expect(result).toMatchObject({ status: 'ok', raw: 'Speak Chinese.\n\nHello', output: 'SPEAK CHINESE.\n\nHELLO', runtime: 'local', cleanup: 'complete' });
      expect(await store.read(result.artifact!)).toBe(result.output);
      expect(local).toEqual(global);
      expect(local.filter(event => event.type === 'completed')).toHaveLength(1);
      expect(local.every((event, i) => event.takeId === result.takeId && event.seq === i)).toBe(true);
    } finally { await app.close(); }
  });

  it('routes call overrides, agent preference and default without changing the role', async () => {
    const first = runtime('one'), second = runtime('two');
    const preferred = defineAgent({ id: 'preferred', instructions: '', runtime: 'second' });
    const app = createAgentin({ agents: [assistant(), preferred], runtimes: { first, second }, defaultRuntime: 'first', artifacts: createMemoryStore() });
    try {
      expect((await app.run({ agent: 'assistant', input: 'a' })).runtime).toBe('first');
      expect((await app.run({ agent: 'preferred', input: 'b' })).runtime).toBe('second');
      expect((await app.run({ agent: 'preferred', input: 'c', runtime: 'first' })).runtime).toBe('first');
      // The Engine also calls command with an empty prompt for capability preflight.
      expect(vi.mocked(first.command).mock.calls.filter(([ctx]) => ctx.prompt !== '')).toHaveLength(2);
      expect(vi.mocked(second.command).mock.calls.filter(([ctx]) => ctx.prompt !== '')).toHaveLength(1);
    } finally { await app.close(); }
  });

  it('passes declared MCP routes through Engine and Hub to a real stdio upstream', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentin-sdk-'));
    mkdirSync(join(root, 'manifests', 'mcp-servers'), { recursive: true });
    writeFileSync(join(root, 'manifests', 'mcp-servers', 'weather.json'), JSON.stringify({
      id: 'weather', transport: 'stdio', command: process.execPath,
      args: [resolve('agent-engine/src/__tests__/fixture/fake-mcp-server.cjs')],
    }));
    const script = `
      const assert = require('node:assert/strict');
      const { Client } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/client/index.js'))});
      const { StdioClientTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'))});
      (async () => {
        const config = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
        const server = Object.values(config.mcpServers)[0];
        const client = new Client({name:'sdk-test',version:'1'}, {capabilities:{}});
        try {
          await client.connect(new StdioClientTransport(server));
          assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['weather-get']);
          await assert.rejects(client.callTool({name:'boom',arguments:{}}));
          const result = await client.callTool({name:'weather-get',arguments:{city:'Taipei'}});
          process.stdout.write(result.content[0].text);
        } finally { await client.close(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const adapter: SpawnRuntime = {
      ...runtime(),
      command: ({ mcpConfigPath }) => ({ file: process.execPath, args: ['-e', script, mcpConfigPath ?? ''] }),
    };
    const app = createAgentin({
      root, artifacts: createMemoryStore(), defaultRuntime: 'local', runtimes: { local: adapter },
      agents: [defineAgent({ id: 'weather', instructions: '', tools: [{ id: 'weather-get', serverId: 'weather', toolName: 'get_weather' }] })],
    });
    try {
      expect(await app.run({ agent: 'weather', input: 'weather', timeoutMs: 4000 })).toMatchObject({ status: 'ok', output: 'Taipei: 27C cloudy', cleanup: 'complete' });
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps concurrent runs and their events isolated', async () => {
    const app = setup();
    const events: RunEvent[][] = [[], []];
    try {
      const results = await Promise.all(['one', 'two'].map((input, i) => app.run({ agent: 'assistant', input, onEvent: event => events[i].push(event) })));
      expect(results.map(result => result.raw)).toEqual(['Speak Chinese.\n\none', 'Speak Chinese.\n\ntwo']);
      expect(results[0].takeId).not.toBe(results[1].takeId);
      events.forEach((list, i) => expect(list.every(event => event.takeId === results[i].takeId)).toBe(true));
    } finally { await app.close(); }
  });

  it('returns capability failure before spawning and never falls back', async () => {
    const rejected = runtime('limited'), fallback = runtime('fallback');
    const agent = defineAgent({ id: 'skilled', instructions: '', skills: ['plugin'] });
    const app = createAgentin({ agents: [agent], runtimes: { rejected, fallback }, defaultRuntime: 'rejected', artifacts: createMemoryStore() });
    try {
      expect(await app.run({ agent: 'skilled', input: 'x' })).toMatchObject({ status: 'error', error: { kind: 'capability' } });
      expect(rejected.command).not.toHaveBeenCalled();
      expect(fallback.command).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('cancels a run and closes all active runtime engines idempotently', async () => {
    const pending = runtime('pending', "process.stdin.resume();setInterval(()=>{},1000)");
    const app = createAgentin({ agents: [assistant()], runtimes: { first: pending, second: pending }, defaultRuntime: 'first', artifacts: createMemoryStore() });
    const abort = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const run = app.run({ agent: 'assistant', input: 'x', signal: abort.signal, onEvent: event => { if (event.type === 'started') started(); } });
    await ready;
    abort.abort();
    expect(await run).toMatchObject({ status: 'cancelled', cleanup: 'complete' });
    const first = app.run({ agent: 'assistant', input: 'x' });
    const second = app.run({ agent: 'assistant', input: 'x', runtime: 'second' });
    const close = app.close();
    expect(app.close()).toBe(close);
    await close;
    expect((await first).status).toBe('cancelled');
    expect((await second).status).toBe('cancelled');
    await expect(app.run({ agent: 'assistant', input: 'x' })).rejects.toThrow(/closed/);
  });

  it('passes timeout and output parsing failures through the result contract', async () => {
    const app = setup(runtime('hang', "process.stdin.resume();setInterval(()=>{},1000)"));
    try {
      expect(await app.run({ agent: 'assistant', input: 'x', timeoutMs: 40 })).toMatchObject({ status: 'truncated', stopReason: 'timeout' });
    } finally { await app.close(); }
    const echo = setup();
    try {
      expect(await echo.run({ agent: 'assistant', input: 'x', parseOutput: () => { throw new Error('schema mismatch'); } })).toMatchObject({ status: 'error', error: { kind: 'output' } });
    } finally { await echo.close(); }
  });

  it('snapshots registration and rejects invalid requests before dispatch', async () => {
    const adapter = runtime();
    const declarations = [assistant()];
    const config = { agents: declarations, runtimes: { local: adapter }, defaultRuntime: 'local', artifacts: createMemoryStore() };
    const app = createAgentin(config);
    declarations.length = 0;
    config.defaultRuntime = 'missing';
    adapter.command = () => { throw new Error('mutated'); };
    try {
      expect((await app.run({ agent: 'assistant', input: 'x' })).status).toBe('ok');
      await expect(app.run({ agent: 'missing', input: 'x' })).rejects.toThrow(/unknown agent/);
      await expect(app.run({ agent: 'assistant', input: 'x', runtime: 'missing' })).rejects.toThrow(/unknown runtime/);
      await expect(app.run({ agent: 'assistant', input: 'x', timeoutMs: NaN })).rejects.toThrow(/positive finite/);
    } finally { await app.close(); }
  });
});

describe('definitions and Claude registration', () => {
  it('denies native tools by default and retains explicit permissions', () => {
    const agent = assistant();
    expect(agent.capabilities).toEqual({ filesystem: 'none', shell: false });
    expect(Object.isFrozen(agent.capabilities)).toBe(true);
    const command = claudeRuntime().command({ prompt: 'x', capabilities: agent.capabilities });
    const index = command.args.indexOf('--tools');
    expect(command.args[index + 1]).toBe('');
    expect(command.args).toContain('--strict-mcp-config');
    expect(defineAgent({ id: 'reader', instructions: '', capabilities: { filesystem: 'read-only' } }).capabilities).toEqual({ filesystem: 'read-only', shell: false });
  });

  it('rejects duplicate IDs, unknown settings, undeclared runtimes and experimental adapters', () => {
    expect(() => defineAgent({ id: 'a', instructions: '', typo: true } as never)).toThrow(/unknown agent/);
    expect(() => defineAgent({ id: '../escape', instructions: '' })).toThrow();
    const config = { agents: [assistant(), assistant()], runtimes: { local: runtime() }, defaultRuntime: 'local' };
    expect(() => createAgentin(config)).toThrow(/duplicate agent/);
    expect(() => createAgentin({ ...config, agents: [], defaultRuntime: 'missing' })).toThrow(/unknown default/);
    expect(() => createAgentin({ ...config, agents: [defineAgent({ id: 'a', instructions: '', runtime: 'missing' })] })).toThrow(/unknown runtime/);
    expect(() => createAgentin({ ...config, agents: [], runtimes: { local: { ...runtime(), experimental: 'unverified' } } })).toThrow(/experimental/);
  });
});
