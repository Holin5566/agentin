import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeDecoder } from '../runtimes/claudeStream.js';
import { claudeCli } from '../runtimes/claudeCli.js';
import type { RuntimeEvent } from '../types.js';

/**
 * fixture 是**真的跑一次 `claude -p --output-format stream-json` 抓下來的**,
 * 不是照文件編的。那一次讓它讀一個檔,所以涵蓋 tool_use / tool_result。
 *
 * 用真實輸出當 fixture 的理由:decoder 的全部價值就是「跟現實對得上」,
 * 拿自己編的樣本去測等於自問自答。
 */
const REAL = readFileSync(join(__dirname, 'fixture', 'claude-stream-with-tool.jsonl'), 'utf8');

/** 一次餵完,模擬最理想的情況。 */
function decodeAll(text: string): RuntimeEvent[] {
  const d = createClaudeDecoder();
  return [...d.push(text), ...d.finish()];
}

/** 逐字元餵,模擬最糟的 chunk 切法。 */
function decodeByChar(text: string): RuntimeEvent[] {
  const d = createClaudeDecoder();
  const out: RuntimeEvent[] = [];
  for (const ch of text) out.push(...d.push(ch));
  out.push(...d.finish());
  return out;
}

describe('對真實輸出解碼', () => {
  const events = decodeAll(REAL);
  const types = events.map((e) => e.type);

  it('認得工具呼叫 —— 這是沒有 decoder 就拿不到的東西', () => {
    const start = events.find((e) => e.type === 'tool-start') as any;
    expect(start).toMatchObject({ toolId: 'Bash' });
    expect(start.toolCallId).toMatch(/^toolu_/);
    expect(start.input).toEqual({ command: 'cat probe.txt', description: 'Read probe.txt' });
  });

  it('工具結果配得回同一個 toolCallId', () => {
    const start = events.find((e) => e.type === 'tool-start') as any;
    const end = events.find((e) => e.type === 'tool-end') as any;
    expect(end.toolCallId).toBe(start.toolCallId);
    expect(end.ok).toBe(true);
    expect(end.output).toBe('marker-abc');
  });

  it('最終輸出取 result 的全文,不是把片段黏起來', () => {
    const output = events.filter((e) => e.type === 'output').at(-1) as any;
    expect(output.text).toBe('marker-abc');
  });

  it('usage 是整次執行的累計,不是增量', () => {
    const usage = events.find((e) => e.type === 'usage') as any;
    expect(usage.mode).toBe('cumulative');
    expect(usage.usage.outputTokens).toBeGreaterThan(0);
  });

  it('正常結束是 end_turn', () => {
    const stopped = events.filter((e) => e.type === 'stopped');
    expect(stopped).toHaveLength(1);
    expect((stopped[0] as any).reason).toBe('end_turn');
  });

  it('system / rate_limit_event 這類雜訊不會變成事件', () => {
    // 不認得的型別要略過而不是爆掉 —— CLI 會一直新增事件型別。
    expect(types).not.toContain('text-system');
    expect(events.filter((e) => e.type === 'text').every((e: any) => e.chunk.length > 0)).toBe(true);
  });
});

describe('chunk 邊界', () => {
  it('逐字元餵進去的結果跟一次餵完完全一樣', () => {
    // JSONL 一定會在某次 chunk 邊界被切開,這是無狀態 parse(chunk) 做不到的事。
    //
    // elapsedMs 由 Date.now() 算出,兩次解碼跨過毫秒邊界就會差 1 —— 直接比對
    // 會變成偶發失敗的測試。只正規化這一個欄位,其餘照舊逐欄比。
    const stable = (events: RuntimeEvent[]) =>
      events.map((e) => (e.type === 'tool-end' ? { ...e, elapsedMs: 0 } : e));
    expect(stable(decodeByChar(REAL))).toEqual(stable(decodeAll(REAL)));
  });

  it('最後一行沒有換行結尾時,finish() 仍解得出來', () => {
    const noTrailing = REAL.trimEnd();
    const stopped = decodeAll(noTrailing).filter((e) => e.type === 'stopped');
    expect((stopped[0] as any).reason).toBe('end_turn');
  });
});

describe('終止原因', () => {
  const resultLine = (fields: Record<string, unknown>) =>
    JSON.stringify({ type: 'result', subtype: 'success', result: 'x', ...fields }) + '\n';
  const reasonOf = (jsonl: string) =>
    (decodeAll(jsonl).find((e) => e.type === 'stopped') as any)?.reason;

  it('max_tokens 照實傳,不會被當成正常結束', () => {
    expect(reasonOf(resultLine({ stop_reason: 'max_tokens' }))).toBe('max_tokens');
  });

  it('回合數用完對應 max_turn_requests —— 跟逾時同類,值得 salvage', () => {
    expect(reasonOf(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }) + '\n'))
      .toBe('max_turn_requests');
  });

  it('refusal 自成一類', () => {
    expect(reasonOf(resultLine({ stop_reason: 'refusal' }))).toBe('refusal');
  });

  it('串流在 result 之前就斷掉時回 unknown,不假裝成功', () => {
    // 最重要的一條:少了它,一個被截斷的執行會因為退出碼 0 而被報成完整結果。
    const truncated = REAL.split('\n').slice(0, 6).join('\n') + '\n';
    expect(reasonOf(truncated)).toBe('unknown');
  });

  it('一行壞掉的 JSON 不會毀掉整次解碼', () => {
    const withNoise = REAL.replace('{"type": "rate_limit_event"', 'not json at all {"type": "rate_limit_event"');
    expect(reasonOf(withNoise)).toBe('end_turn');
  });
});

describe('adapter 接線', () => {
  it('組出來的指令真的會產生 stream-json', () => {
    // decoder 寫好了但旗標沒下,拿到的會是純文字 —— 事件永遠是空的。
    const args = claudeCli.command({ prompt: 'p' }).args;
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
    // `-p` 配 stream-json 時 CLI 要求一併給 --verbose。
    expect(args).toContain('--verbose');
  });

  it('adapter 掛上了 decoder', () => {
    expect(claudeCli.createDecoder).toBeDefined();
    expect(claudeCli.createDecoder!()).toHaveProperty('push');
  });

  it('每次 take 拿到新的 decoder,不共用緩衝', () => {
    expect(claudeCli.createDecoder!()).not.toBe(claudeCli.createDecoder!());
  });
});

 it('is_error overrides a success subtype and end_turn', () => {
  const decoder = claudeCli.createDecoder!();
  const events = decoder.push(JSON.stringify({ type: 'result', subtype: 'success', stop_reason: 'end_turn', is_error: true, result: 'Not logged in' }) + '\n');
  expect(events).toContainEqual({ type: 'stopped', reason: 'unknown' });
});
