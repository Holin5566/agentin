import type { RuntimeDecoder, RuntimeEvent, StopReason } from '../types.js';

/** OpenCode run --format json emits completed parts, not text deltas. */
export function createOpenCodeDecoder(): RuntimeDecoder {
  let buffer = '', output = '';
  let reason: StopReason = 'unknown';
  let failed = false;
  const seen = new Set<string>();
  function line(raw: string): RuntimeEvent[] {
    let row: any;
    try { row = JSON.parse(raw); } catch { return []; }
    const part = row?.part;
    if (row?.type === 'error') { failed = true; return []; }
    if (row?.type === 'step_start') reason = 'unknown';
    if (row?.type === 'text' && typeof part?.text === 'string') {
      if (part.id && seen.has(part.id)) return [];
      if (part.id) seen.add(part.id);
      output += part.text;
      return [{ type: 'text', chunk: part.text }];
    }
    if (row?.type === 'tool_use' && typeof part?.callID === 'string') {
      if (seen.has(part.callID)) return [];
      seen.add(part.callID);
      const state = part.state;
      if (state?.status !== 'completed' && state?.status !== 'error') return [];
      return [
        { type: 'tool-start', toolCallId: part.callID, toolId: part.tool, input: state.input },
        { type: 'tool-end', toolCallId: part.callID, toolId: part.tool, ok: state.status === 'completed', elapsedMs: Math.max(0, (state.time?.end ?? 0) - (state.time?.start ?? 0)), output: state.output ?? state.error },
      ];
    }
    if (row?.type === 'step_finish') {
      reason = part?.reason === 'stop' ? 'end_turn' : part?.reason === 'length' ? 'max_tokens' : 'unknown';
      const tokens = part?.tokens;
      return tokens ? [{ type: 'usage', mode: 'delta', usage: { inputTokens: tokens.input, outputTokens: tokens.output } }] : [];
    }
    return [];
  }
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      return lines.flatMap(line);
    },
    finish() {
      const tail = buffer.trim() ? line(buffer) : [];
      buffer = '';
      return [...tail, { type: 'output', text: output }, { type: 'stopped', reason: failed ? 'unknown' : reason }];
    },
  };
}
