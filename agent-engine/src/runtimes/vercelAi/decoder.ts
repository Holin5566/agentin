/**
 * runner 的 JSONL(見 `protocol.ts`)→ engine 的 `RuntimeEvent`。跟 `claudeStream.ts` 同一個位置、同一個模式。
 */
import type { RuntimeDecoder, RuntimeEvent } from '../../types.js';
import type { RunnerLine } from './protocol.js';

export function createVercelAiDecoder(): RuntimeDecoder {
  let buffer = '';
  let sawDone = false;

  function decodeLine(line: string): RuntimeEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let parsed: RunnerLine;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 一行雜訊不該毀掉整次執行。真正的問題會在 finish() 現形:沒看到 done 就回 unknown。
      return [];
    }

    switch (parsed.t) {
      case 'text':
        return typeof parsed.chunk === 'string' ? [{ type: 'text', chunk: parsed.chunk }] : [];
      case 'tool-start':
        return [{
          type: 'tool-start',
          toolCallId: parsed.id,
          toolId: parsed.name,
          ...(parsed.input !== undefined ? { input: parsed.input } : {}),
        }];
      case 'tool-end':
        return [{
          type: 'tool-end',
          toolCallId: parsed.id,
          ok: parsed.ok,
          elapsedMs: parsed.elapsedMs,
          ...(parsed.output !== undefined ? { output: parsed.output } : {}),
        }];
      case 'done': {
        sawDone = true;
        const out: RuntimeEvent[] = [{ type: 'output', text: parsed.output }];
        const u = parsed.usage;
        // 這一筆是整次執行的總量,不是增量。
        if (u && (u.inputTokens !== undefined || u.outputTokens !== undefined)) {
          out.push({ type: 'usage', mode: 'cumulative', usage: u });
        }
        out.push({ type: 'stopped', reason: parsed.reason });
        return out;
      }
      default:
        return [];
    }
  }

  return {
    push(chunk: string): RuntimeEvent[] {
      buffer += chunk;
      const lines = buffer.split('\n');
      // 最後一段可能只是半行 —— 留在緩衝區等下一個 chunk。
      buffer = lines.pop() ?? '';
      return lines.flatMap(decodeLine);
    },

    finish(): RuntimeEvent[] {
      const tail = buffer;
      buffer = '';
      const out = tail ? decodeLine(tail) : [];
      if (!sawDone) {
        // runner 在 done 之前就斷了。**不能讓它退回「退出碼 0 = 成功」** —— 那會把被截斷的執行報成完整結果。
        out.push({ type: 'stopped', reason: 'unknown' });
      }
      return out;
    },
  };
}
