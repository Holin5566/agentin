import { startFakeOpenAi } from '../../agent-engine/src/__tests__/helpers/fakeOpenAi.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { opencodeRuntime, vercelAiRuntime, claudeRuntime, createAgentin, createMemoryStore, defineAgent } from '../../src/index.js';
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


describe('Vercel AI public runtime', () => {
  it('runs the AI SDK subprocess with model overrides, usage and events', async () => {
    const server = await startFakeOpenAi(() => ({ kind: 'text', text: '你好', usage: { prompt: 5, completion: 2 } }));
    const options = { baseUrl: server.url, model: 'default-model', apiKey: 'test-key' };
    const adapter = vercelAiRuntime(options);
    options.model = 'mutated-model';
    const events: RunEvent[] = [];
    const app = createAgentin({ agents: [assistant()], runtimes: { ai: adapter }, defaultRuntime: 'ai', artifacts: createMemoryStore() });
    try {
      const first = await app.run({ agent: 'assistant', input: 'Hello', onEvent: event => events.push(event), timeoutMs: 3000 });
      expect(first).toMatchObject({ status: 'ok', runtime: 'ai', output: '你好', usage: { inputTokens: 5, outputTokens: 2 }, cleanup: 'complete' });
      expect(events.some(event => event.type === 'text')).toBe(true);
      expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
      expect(server.requests[0].body.model).toBe('default-model');
      expect(server.requests[0].headers.authorization).toBe('Bearer test-key');
      expect((await app.run({ agent: 'assistant', input: 'Hi', model: 'override-model', timeoutMs: 3000 })).status).toBe('ok');
      expect(server.requests[1].body.model).toBe('override-model');
    } finally { await app.close(); await server.close(); }
  });

  it('reports HTTP errors and rejects unsupported native capabilities without requests', async () => {
    const server = await startFakeOpenAi(() => ({ kind: 'http', status: 401, message: 'invalid key' }));
    const app = createAgentin({
      agents: [assistant(), defineAgent({ id: 'shell', instructions: '', capabilities: { shell: true } })],
      runtimes: { ai: vercelAiRuntime({ baseUrl: server.url, model: 'test' }) }, defaultRuntime: 'ai', artifacts: createMemoryStore(),
    });
    try {
      expect(await app.run({ agent: 'shell', input: 'x' })).toMatchObject({ status: 'error', error: { kind: 'capability' } });
      expect(server.requests).toHaveLength(0);
      expect(await app.run({ agent: 'assistant', input: 'x', timeoutMs: 3000 })).toMatchObject({ status: 'error', error: { kind: 'runtime', status: 401, retryable: false } });
      expect(server.requests).toHaveLength(1);
    } finally { await app.close(); await server.close(); }
  });

  it('requires a compatible endpoint and supports Anthropic registration', () => {
    expect(() => vercelAiRuntime({ model: 'test' })).toThrow(/baseUrl/);
    const adapter = vercelAiRuntime({ provider: 'anthropic', model: 'test', apiKey: 'secret' });
    const command = adapter.command({ prompt: 'hello' });
    expect(command.args).toEqual(expect.arrayContaining(['--provider', 'anthropic']));
    expect(command.args).not.toContain('secret');
    expect(command.env?.VERCEL_AI_API_KEY).toBe('secret');
  });
});


describe('CLI public runtime contracts', () => {
  it.each(['claude', 'opencode'] as const)('runs %s with flags, stdin, decoded events and lifecycle control', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'agentin-cli-'));
    const executable = join(root, 'fake-cli');
    const script = `#!${process.execPath}
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const kind = process.env.TEST_CLI_KIND;
if (kind === 'claude') {
  assert(args.includes('-p') && args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert(args.includes('stream-json') && args.includes('--verbose'));
} else {
  assert.deepEqual(args.slice(0, 3), ['run', '--format', 'json']);
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(Object.values(config.agent)[0].tools['*'], false);
  assert.equal(Object.values(config.agent)[0].permission['*'], 'deny');
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  assert(prompt.includes('Speak Chinese.') && prompt.includes('Hello'));
  if (process.env.TEST_CLI_MODE === 'hang') { setInterval(() => {}, 1000); return; }
  const emit = row => console.log(JSON.stringify(row));
  if (kind === 'claude') {
    emit({type:'assistant',message:{content:[{type:'text',text:'answer'}]}});
    if (process.env.TEST_CLI_MODE !== 'incomplete') emit({type:'result',subtype:'success',result:'answer',usage:{input_tokens:4,output_tokens:2}});
  } else {
    emit({type:'text',part:{id:'t',text:'answer'}});
    if (process.env.TEST_CLI_MODE !== 'incomplete') emit({type:'step_finish',part:{reason:'stop',tokens:{input:4,output:2}}});
  }
});`;
    writeFileSync(executable, script); chmodSync(executable, 0o700);
    const make = (mode = 'normal') => createAgentin({
      root, agents: [assistant()], artifacts: createMemoryStore(), defaultRuntime: kind,
      runtimes: { [kind]: (kind === 'claude' ? claudeRuntime : opencodeRuntime)({ executable, env: { TEST_CLI_KIND: kind, TEST_CLI_MODE: mode } }) },
    });
    const events: RunEvent[] = [];
    const app = make();
    try {
      expect(await app.run({ agent: 'assistant', input: 'Hello', onEvent: event => events.push(event) })).toMatchObject({ status: 'ok', output: 'answer', runtime: kind, cleanup: 'complete', usage: { inputTokens: 4, outputTokens: 2 } });
      expect(events.some(event => event.type === 'text')).toBe(true);
      expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
    } finally { await app.close(); }
    const incomplete = make('incomplete');
    try { expect((await incomplete.run({ agent: 'assistant', input: 'Hello' })).status).toBe('error'); }
    finally { await incomplete.close(); }
    const pending = make('hang');
    try {
      expect(await pending.run({ agent: 'assistant', input: 'Hello', timeoutMs: 100 })).toMatchObject({ status: 'truncated', stopReason: 'timeout' });
      const run = pending.run({ agent: 'assistant', input: 'Hello' });
      await pending.close();
      expect((await run).status).toBe('cancelled');
    } finally { await pending.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
