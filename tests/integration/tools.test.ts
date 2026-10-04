import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAgentin, createMemoryStore, defineAgent, defineTool, ToolFailure, vercelAiRuntime } from '../../src/index.js';
import type { FunctionTool } from '../../src/index.js';
import type { ToolBridge } from '../../src/tools/bridge.js';
import { openToolBridge } from '../../src/tools/bridge.js';
import { startFakeOpenAi } from '../../agent-engine/src/__tests__/helpers/fakeOpenAi.js';

const schema = { type: 'object' as const, properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };

describe('host function bridge', () => {
  it('runs host closures across runner, gateway and stdio proxy', async () => {
    const captured = 'host-only';
    const execute = vi.fn<FunctionTool['execute']>(async (args, context) => `${captured}:${args.message}:${context.agent}`);
    const tool = defineTool({ id: 'host_echo', description: 'Echo', inputSchema: schema, execute });
    const root = mkdtempSync(join(tmpdir(), 'agentin-mixed-'));
    mkdirSync(join(root, 'manifests', 'mcp-servers'), { recursive: true });
    writeFileSync(join(root, 'manifests', 'mcp-servers', 'weather.json'), JSON.stringify({
      id: 'weather', transport: 'stdio', command: process.execPath,
      args: [resolve('agent-engine/src/__tests__/fixture/fake-mcp-server.cjs')], tools: { weather_get: 'get_weather' },
    }));
    const model = await startFakeOpenAi(n => n === 0 ? { kind: 'call', name: 'host_echo', args: '{"message":"hello"}' } : n === 1 ? { kind: 'call', name: 'weather_get', args: '{"city":"Taipei"}' } : { kind: 'text', text: 'done' });
    const app = createAgentin({
      root, agents: [defineAgent({ id: 'assistant', instructions: '', tools: [tool, 'weather_get'] })],
      runtimes: { ai: vercelAiRuntime({ baseUrl: model.url, model: 'test' }) }, defaultRuntime: 'ai', artifacts: createMemoryStore(),
    });
    try {
      const result = await app.run({ agent: 'assistant', input: 'use the tool', timeoutMs: 4000 });
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ status: 'ok', output: 'done', cleanup: 'complete' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][1]).toMatchObject({ agent: 'assistant', runId: expect.any(String) });
      expect(execute.mock.calls[0][1].signal.aborted).toBe(true);
      expect(JSON.stringify(model.requests[1].body.messages)).toContain('host-only:hello:assistant');
      expect(JSON.stringify(model.requests[2].body.messages)).toContain('Taipei: 27C cloudy');
    } finally { await app.close(); await model.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('scopes credentials and tool lists per run, validates inputs and preserves full results', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'image' as const, data: 'YWJj', mimeType: 'image/png' }], structuredContent: { value: 2 }, _meta: { trace: 'x' } }));
    const tool = defineTool({ id: 'picture', description: 'picture', inputSchema: schema, execute });
    const abort = new AbortController();
    const first = await openToolBridge([tool], 'one', abort.signal);
    const second = await openToolBridge([defineTool({ id: 'other', description: 'other', inputSchema: schema, execute: async () => 'ok' })], 'two', abort.signal);
    const request = (bridge: ToolBridge, path: string, body?: unknown, token = bridge.server.env!.AGENTIN_BRIDGE_TOKEN) => fetch(bridge.server.env!.AGENTIN_BRIDGE_URL + path, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    try {
      expect((await request(first, '/tools', undefined, second.server.env!.AGENTIN_BRIDGE_TOKEN)).status).toBe(403);
      expect((await (await request(first, '/tools')).json()).map((tool: { id: string }) => tool.id)).toEqual(['picture']);
      expect((await request(first, '/call', { id: 'other', args: { message: 'x' } })).status).toBe(500);
      const invalid = await (await request(first, '/call', { id: 'picture', args: {} })).json();
      expect(invalid.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      const result = await (await request(first, '/call', { id: 'picture', args: { message: 'x' } })).json();
      expect(result).toMatchObject({ isError: false, structuredContent: { value: 2 }, _meta: { trace: 'x' }, content: [{ type: 'image' }] });
      await first.close();
      await expect(request(first, '/tools')).rejects.toThrow();
      expect((await request(second, '/tools')).status).toBe(200);
    } finally { await first.close(); await second.close(); }
  });

  it('propagates cancellation to host functions and keeps tool failures distinct', async () => {
    const abort = new AbortController();
    let entered!: () => void, cancelled!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { cancelled = resolve; });
    const wait = defineTool({ id: 'wait', description: 'wait', inputSchema: schema, execute: async (_args, { signal }) => {
      entered();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
      signal.throwIfAborted(); return 'unexpected';
    } });
    const fail = defineTool({ id: 'fail', description: 'fail', inputSchema: schema, execute: async () => { throw new ToolFailure('expected failure'); } });
    const bridge = await openToolBridge([wait, fail], 'a', abort.signal);
    const request = (id: string) => fetch(bridge.server.env!.AGENTIN_BRIDGE_URL + '/call', { method: 'POST', headers: { authorization: `Bearer ${bridge.server.env!.AGENTIN_BRIDGE_TOKEN}` }, body: JSON.stringify({ id, args: { message: 'x' } }) });
    try {
      expect(await (await request('fail')).json()).toMatchObject({ isError: true, content: [{ type: 'text', text: 'expected failure' }] });
      const pending = request('wait');
      await ready;
      abort.abort();
      await stopped;
      expect((await pending).status).toBe(500);
    } finally { await bridge.close(); }
  });

  it('cancels host code on SDK close, including runs cancelled before bridge startup', async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    const tool = defineTool({ id: 'wait', description: 'wait', inputSchema: schema, execute: async (_args, context) => {
      signal = context.signal; entered();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return 'cancelled';
    } });
    const model = await startFakeOpenAi(() => ({ kind: 'call', name: 'wait', args: '{"message":"x"}' }));
    const app = createAgentin({ agents: [defineAgent({ id: 'a', instructions: '', tools: [tool] })], runtimes: { ai: vercelAiRuntime({ baseUrl: model.url, model: 'test' }) }, defaultRuntime: 'ai', artifacts: createMemoryStore() });
    try {
      expect((await app.run({ agent: 'a', input: 'x', signal: AbortSignal.abort() })).status).toBe('cancelled');
      expect(model.requests).toHaveLength(0);
      const pending = app.run({ agent: 'a', input: 'x', timeoutMs: 4000 });
      await ready;
      await app.close();
      expect(signal?.aborted).toBe(true);
      expect((await pending).status).toBe('cancelled');
    } finally { await app.close(); await model.close(); }
  });

  it('rejects tool ID collisions and leaves definitions immutable', () => {
    const tool = defineTool({ id: 'echo', description: 'echo', inputSchema: schema, execute: async () => 'ok' });
    expect(Object.isFrozen(tool.inputSchema.properties)).toBe(true);
    expect(() => defineAgent({ id: 'a', instructions: '', tools: [tool, tool] })).toThrow(/duplicate/);
  });
});
