import { describe, expect, it } from 'vitest';
import { createVercelAiDecoder } from '../runtimes/vercelAi/decoder.js';
import { encodeLine } from '../runtimes/vercelAi/protocol.js';
import type { RunnerLine } from '../runtimes/vercelAi/protocol.js';

const feed = (lines: RunnerLine[]) => lines.map(encodeLine).join('');

describe('vercel-ai decoder', () => {
  it('runner 的每種行 → 對應的 RuntimeEvent', () => {
    const d = createVercelAiDecoder();
    const ev = d.push(feed([
      { t: 'text', chunk: 'hi' },
      { t: 'tool-start', id: 'c1', name: 'get_weather', input: { city: 'T' } },
      { t: 'tool-end', id: 'c1', ok: false, elapsedMs: 12, output: 'boom' },
      { t: 'done', reason: 'end_turn', output: 'final', usage: { inputTokens: 5, outputTokens: 2 } },
    ]));
    expect(ev).toEqual([
      { type: 'text', chunk: 'hi' },
      { type: 'tool-start', toolCallId: 'c1', toolId: 'get_weather', input: { city: 'T' } },
      { type: 'tool-end', toolCallId: 'c1', ok: false, elapsedMs: 12, output: 'boom' },
      { type: 'output', text: 'final' },
      { type: 'usage', mode: 'cumulative', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'stopped', reason: 'end_turn' },
    ]);
    expect(d.finish()).toEqual([]);
  });

  it('半行留在緩衝區,下個 chunk 接上', () => {
    const d = createVercelAiDecoder();
    const s = feed([{ t: 'text', chunk: 'hello' }]);
    expect(d.push(s.slice(0, 6))).toEqual([]);
    expect(d.push(s.slice(6))).toEqual([{ type: 'text', chunk: 'hello' }]);
  });

  it('雜訊行與不認得的行略過,不毀掉整次執行', () => {
    const d = createVercelAiDecoder();
    const ev = d.push('warning: something\n{"t":"future-thing"}\n' + feed([{ t: 'text', chunk: 'ok' }]));
    expect(ev).toEqual([{ type: 'text', chunk: 'ok' }]);
  });

  it('沒看到 done 就收尾 → stopped unknown,不能當成功', () => {
    const d = createVercelAiDecoder();
    d.push(feed([{ t: 'text', chunk: 'partial' }]));
    expect(d.finish()).toEqual([{ type: 'stopped', reason: 'unknown' }]);
  });

  it('done 沒帶 usage 就不發 usage 事件', () => {
    const d = createVercelAiDecoder();
    const ev = d.push(feed([{ t: 'done', reason: 'max_turn_requests', output: '' }]));
    expect(ev.map((e) => e.type)).toEqual(['output', 'stopped']);
  });

  it('結尾沒有換行的最後一行,finish 時補解', () => {
    const d = createVercelAiDecoder();
    d.push(JSON.stringify({ t: 'done', reason: 'end_turn', output: 'x' }));
    expect(d.finish()).toEqual([{ type: 'output', text: 'x' }, { type: 'stopped', reason: 'end_turn' }]);
  });
});
