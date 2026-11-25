/**
 * `claude -p --output-format stream-json` 的 JSONL decoder。
 *
 * **格式是對真實輸出抓下來核對過的**,不是照文件猜的。實際觀察到的行型別:
 *
 *   system          subtype: init / hook_started / hook_response —— 都略過
 *   assistant       message.content[] 裡是 { type: 'text' } 或 { type: 'tool_use' }
 *   user            message.content[] 裡是 { type: 'tool_result' }
 *   rate_limit_event 略過
 *   result          subtype / stop_reason / result(最終全文)/ usage
 *
 * 少了這一層,`tool-start` / `tool-end` / `usage` 這幾個事件在 CLI 家族上
 * **根本無法實作** —— stdout 只是一坨文字,看不出模型呼叫了什麼。
 */
import type { RuntimeDecoder, RuntimeEvent, StopReason, Usage } from '../types.js';

/**
 * claude 的終止原因 → 我們的 `StopReason`。
 *
 * `error_max_turns` 對應 `max_turn_requests`:兩者都是「回合數用完」,而那跟
 * 逾時同類 —— 被預算砍斷但可能已經產出有用的東西,值得 salvage。
 */
function stopReasonOf(line: any): StopReason {
  const subtype = String(line.subtype ?? '');
  if (subtype.startsWith('error_max_turns')) return 'max_turn_requests';

  if (line.is_error === true) return 'unknown';

  switch (line.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      // 包含 subtype=success 但沒帶 stop_reason、以及各種 error_* 。
      return subtype === 'success' ? 'end_turn' : 'unknown';
  }
}

function usageOf(raw: any): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage: Usage = {};
  if (typeof raw.input_tokens === 'number') usage.inputTokens = raw.input_tokens;
  if (typeof raw.output_tokens === 'number') usage.outputTokens = raw.output_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** `message.content` 偶爾是字串而不是陣列,別假設。 */
const blocksOf = (message: any): any[] =>
  Array.isArray(message?.content) ? message.content : [];

export function createClaudeDecoder(): RuntimeDecoder {
  let buffer = '';
  /** tool_use 的時間,用來在 tool_result 時算出耗時。 */
  const toolStartedAt = new Map<string, number>();
  let sawResult = false;

  function decodeLine(line: string): RuntimeEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 一行雜訊不該毀掉整次執行(CLI 偶爾會在 stdout 印警告)。真正的問題會在
      // finish() 那邊現形:沒看到 result 就回 unknown,不會假裝成功。
      return [];
    }

    switch (parsed.type) {
      case 'assistant': {
        const out: RuntimeEvent[] = [];
        for (const block of blocksOf(parsed.message)) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            out.push({ type: 'text', chunk: block.text });
          } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
            toolStartedAt.set(block.id, Date.now());
            out.push({
              type: 'tool-start',
              toolCallId: block.id,
              ...(typeof block.name === 'string' ? { toolId: block.name } : {}),
              ...(block.input !== undefined ? { input: block.input } : {}),
            });
          }
        }
        return out;
      }

      case 'user': {
        const out: RuntimeEvent[] = [];
        for (const block of blocksOf(parsed.message)) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          const startedAt = toolStartedAt.get(block.tool_use_id);
          toolStartedAt.delete(block.tool_use_id);
          out.push({
            type: 'tool-end',
            toolCallId: block.tool_use_id,
            // is_error 是工具**自己回報**的失敗,不是 CLI 掛了 —— 三態要分開。
            ok: block.is_error !== true,
            elapsedMs: startedAt !== undefined ? Date.now() - startedAt : 0,
            ...(block.content !== undefined ? { output: block.content } : {}),
          });
        }
        return out;
      }

      case 'result': {
        sawResult = true;
        const out: RuntimeEvent[] = [];
        // result.result 是最終全文,取代逐則累積起來的文字(中間可能有思考片段)。
        if (typeof parsed.result === 'string') out.push({ type: 'output', text: parsed.result });
        const usage = usageOf(parsed.usage);
        // 這一筆是整次執行的總量,不是增量。
        if (usage) out.push({ type: 'usage', mode: 'cumulative', usage });
        out.push({ type: 'stopped', reason: stopReasonOf(parsed) });
        return out;
      }

      default:
        // system / rate_limit_event / 未來新增的型別:略過,不要因為不認得就爆掉。
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
      if (!sawResult) {
        // 串流在 result 之前就斷了。**不能讓它退回「退出碼 0 = 成功」** ——
        // 那會把一個被截斷的執行報成完整結果。
        out.push({ type: 'stopped', reason: 'unknown' });
      }
      return out;
    },
  };
}
