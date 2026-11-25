import { afterEach, describe, expect, it } from 'vitest';
import { capText, fitSdkContext, omittedNote, runLoop, THINK_LESS_NUDGE, EMPTY_ANSWER_NUDGE } from '../runtimes/vercelAi/loop.js';
import type { LoopOptions, ToolPort } from '../runtimes/vercelAi/loop.js';
import type { RunnerLine } from '../runtimes/vercelAi/protocol.js';
import { createVercelAiModel } from '../runtimes/vercelAi/model.js';
import { startFakeOpenAi } from './helpers/fakeOpenAi.js';
import type { Reply } from './helpers/fakeOpenAi.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function setup(reply: (n: number, body: any) => Reply, overrides: Partial<LoopOptions> = {}) {
  const server = await startFakeOpenAi(reply); cleanups.push(server.close);
  const lines: RunnerLine[] = [];
  const calls: unknown[] = [];
  const tools: ToolPort = {
    schemas: [{ name: 'weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    call: async (name, args) => { calls.push([name, args]); return { ok: true, text: '27C' }; },
  };
  const run = () => runLoop({ model: createVercelAiModel({ baseUrl: server.url, model: 'm' }), tools, prompt: 'p', maxSteps: 5,
    maxToolResultChars: 1000, signal: new AbortController().signal, emit: l => lines.push(l), ...overrides });
  return { server, run, lines, calls };
}
const weather: Reply = { kind: 'call', name: 'weather', args: '{"city":"Taipei"}' };

describe('AI SDK loop with a real HTTP model adapter', () => {
  it('SDK executes tools, feeds results back, streams text and sums usage', async () => {
    const t = await setup(n => n === 0 ? weather : { kind: 'text', text: '27 degrees', usage: { prompt: 9, completion: 3 } });
    expect(await t.run()).toMatchObject({ reason: 'end_turn', output: '27 degrees', usage: { inputTokens: 9, outputTokens: 3 } });
    expect(t.calls).toEqual([['weather', { city: 'Taipei' }]]);
    expect(t.server.requests).toHaveLength(2);
    expect(t.server.requests[1].body.messages.at(-1)).toMatchObject({ role: 'tool', content: '27C' });
    expect(t.lines.map(l => l.t)).toEqual(['tool-start', 'tool-end', 'text']);
  });
  it('gateway errors return error text to the model without failing the take', async () => {
    const t = await setup(n => n === 0 ? weather : { kind: 'text', text: 'not available' }, {
      tools: { schemas: [{ name: 'weather', inputSchema: { type: 'object' } }], call: async () => { throw new Error('denied'); } },
    });
    expect(await t.run()).toMatchObject({ output: 'not available' });
    expect(t.server.requests[1].body.messages.at(-1).content).toContain('denied');
    expect(t.lines.find(l => l.t === 'tool-end')).toMatchObject({ ok: false });
  });
  it.each(['{"city":'])('SDK rejects invalid arguments %s without calling gateway', async args => {
    const t = await setup(n => n === 0 ? { ...weather, kind: 'call', args } : { kind: 'text', text: 'corrected' });
    expect(await t.run()).toMatchObject({ output: 'corrected' });
    expect(t.calls).toEqual([]);
    expect(t.server.requests[1].body.messages.at(-1).role).toBe('tool');
    expect(t.lines.find(l => l.t === 'tool-end')).toMatchObject({ ok: false });
  });
  it('unknown tools never execute and SDK feeds the error back', async () => {
    const t = await setup(n => n === 0 ? { kind: 'call', name: 'forbidden', args: '{}' } : { kind: 'text', text: 'cannot access' });
    expect(await t.run()).toMatchObject({ output: 'cannot access' }); expect(t.calls).toEqual([]);
  });
  it('step limit counts SDK rounds including the last tool execution', async () => {
    const t = await setup(() => weather, { maxSteps: 2 });
    expect(await t.run()).toMatchObject({ reason: 'max_turn_requests' });
    expect(t.server.requests).toHaveLength(2); expect(t.calls).toHaveLength(2);
  });
  it('blank answers are nudged once and do not inject empty assistant messages', async () => {
    const t = await setup(n => ({ kind: 'text', text: n === 0 ? '' : 'answer' }));
    expect(await t.run()).toMatchObject({ output: 'answer' });
    expect(t.server.requests[1].body.messages.at(-1).content).toBe(EMPTY_ANSWER_NUDGE);
    expect(t.server.requests[1].body.messages.some((m: any) => m.role === 'assistant')).toBe(false);
    const blank = await setup(() => ({ kind: 'text', text: '' }));
    expect(await blank.run()).toMatchObject({ output: '', reason: 'end_turn' });
    expect(blank.server.requests).toHaveLength(2);
  });
  it('reasoning budget aborts and nudges once, then returns reasoning_budget', async () => {
    const t = await setup(() => ({ kind: 'think', chunks: 20, then: 'hang' }), { maxReasoningTokens: 3 });
    expect(await t.run()).toMatchObject({ reason: 'reasoning_budget' });
    expect(t.server.requests).toHaveLength(2);
    expect(t.server.requests[1].body.messages.at(-1).content).toBe(THINK_LESS_NUDGE);
  });
  it('context guard stops before making an oversized second request', async () => {
    const t = await setup(() => weather, { maxContextChars: 2 });
    expect(await t.run()).toMatchObject({ reason: 'context_exceeded' });
    expect(t.server.requests).toHaveLength(1);
  });
  it('tool results are capped before the SDK feeds them back', async () => {
    const t = await setup(n => n === 0 ? weather : { kind: 'text', text: 'ok' }, {
      maxToolResultChars: 10, tools: { schemas: [{ name: 'weather', inputSchema: { type: 'object' } }], call: async () => ({ ok: true, text: 'x'.repeat(100) }) },
    });
    await t.run(); expect(t.server.requests[1].body.messages.at(-1).content).toBe(capText('x'.repeat(100), 10));
  });
  it('cancellation remains cancellation even while a tool is pending', async () => {
    const ac = new AbortController();
    const t = await setup(() => weather, { signal: ac.signal,
      tools: { schemas: [{ name: 'weather', inputSchema: { type: 'object' } }], call: async () => { ac.abort(); throw new Error('aborted'); } } });
    await expect(t.run()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('HTTP failures preserve the status and do not retry automatically', async () => {
    const t = await setup(() => ({ kind: 'http', status: 401, message: 'no key' }));
    await expect(t.run()).rejects.toThrow('HTTP 401'); expect(t.server.requests).toHaveLength(1);
  });
});

describe('context compaction', () => {
  it('keeps the prompt and latest results, replaces old results without mutating input', () => {
    const messages: any[] = [{ role: 'user', content: 'p' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 't', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: '1', toolName: 't', output: { type: 'text', value: 'x'.repeat(1000) } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '2', toolName: 't', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: '2', toolName: 't', output: { type: 'text', value: 'y'.repeat(1000) } }] }];
    const fit = fitSdkContext(messages, 1200)!;
    expect((fit[2] as any).content[0].output.value).toBe(omittedNote(1000));
    expect((fit[4] as any).content[0].output.value).toHaveLength(1000);
    expect(messages[2].content[0].output.value).toHaveLength(1000);
    expect(fitSdkContext(messages, 10)).toBeUndefined();
  });
});
