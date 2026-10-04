/** AI SDK owns tool execution, message roundtrips and step progression.
 * Guardian adds gateway routing, budgets, recovery and runner event mapping. */
import type { StopReason } from '../../types.js';
import type { RunnerLine } from './protocol.js';
import { jsonSchema, streamText, stepCountIs, tool, type LanguageModel, type ModelMessage } from 'ai';
import { EngineError } from '../../types.js';
import type { LoopToolSchema } from './types.js';

export interface ToolResult {
  /** 工具**自己回報**的失敗(不是 gateway 掛了)。 */
  ok: boolean;
  text: string;
}

export interface ToolPort {
  schemas: LoopToolSchema[];
  /** 丟錯 = 工具呼叫本身失敗(gateway 拒絕、連線斷)。loop 會把它當 tool 錯誤回給模型,不中斷 take。 */
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
}

/**
 * 預設的整體對話預算(字元)。保守估:地端 Qwen / gemma 的 context 約 32k–128k token,中文約一字一 token,
 * 留空間給模型自己的輸出。實際模型的 context 不同時,由宿主用 `maxContextChars` 調。
 */
export const DEFAULT_MAX_CONTEXT_CHARS = 120_000;

/**
 * 思考超過預算、請求被中斷後重來時加的話。為什麼要加、而不是原樣重送:原樣重送等於再賭一次同樣的長思考;
 * 明說「上次想太久被中斷」,讓模型這次收斂。(被中斷那次的思考內容不放回對話 —— 那是一大段沒有結論的草稿,放回去只會吃掉 context。)
 */
export const THINK_LESS_NUDGE = 'Your previous attempt was cut off because it spent too long thinking. Think briefly (a few sentences), then either call a tool or answer in plain text.\n你上一次思考太久被中斷了。請簡短思考,然後直接呼叫工具,或用文字回答。';

/**
 * 預設的單回合思考上限(token,以串流片段數估算)。
 *
 * 為什麼要有:推理模型(實測 Qwen3.6)偶爾會一路想到 `maxTokens` 用完 —— 約 45 秒、8000 token、沒有任何答案(間歇性,
 * 約每 5 次有 1 次;樣本很小)。伺服器端的開關幫不上忙:`enable_thinking=false` 經 bifrost 沒有明顯效果,降 temperature 也沒有改善,
 * 而 vLLM 的 thinking budget 取決於版本、還要 bifrost 與後端肯透傳 —— 我們控制不了。所以在客戶端的串流上自己數、自己斷,
 * 不依賴任何伺服器設定。只算「還沒有任何文字或 tool call」之前的思考:一旦開始回答或叫工具,模型已經收斂。
 * 以 reasoning 片段數近似 token(每片段約一個),不需要 tokenizer;預算本來就只是粗略的安全網。
 *
 * 實測 Qwen 正常回合的思考在幾十到一千多之間,
 * 空轉的會一路到 `maxTokens`(8000)。設 0 = 不限。
 */
export const DEFAULT_MAX_REASONING_TOKENS = 4000;

/** 模型講完了卻沒有任何文字時補問的話(只補一次)。不放一則空的 assistant 訊息:不少 API 會拒收。 */
export const EMPTY_ANSWER_NUDGE = 'Your previous reply contained no text. Based on the information so far, answer in plain text now.\n你上一則回覆沒有文字內容。請依目前已有的資訊,直接用文字回答。';

export interface LoopOptions {
  model: LanguageModel;
  tools: ToolPort;
  prompt: string;
  /** system 訊息(放在對話最前面)。省略 = 不放。 */
  system?: string;
  /** 模型呼叫輪數上限。 */
  maxSteps: number;
  /** 單一 tool 結果塞回對話前的字元上限。 */
  maxToolResultChars: number;
  maxTokens?: number;
  /**
   * 整段對話(system + prompt + 模型輸出 + 工具結果)的字元上限。省略 = 不管。
   * 每個工具結果各自有 `maxToolResultChars`,但 30 步累加起來會遠超過本地模型的 context,
   * 到時模型端回 400、整個 take 失敗 —— 所以要有整體預算。字元只是估算,實際單位是 token(中文約一字一 token)。
   */
  maxContextChars?: number;
  /** 單回合思考上限(token,估算)。省略 / 0 = 不限。見 `DEFAULT_MAX_REASONING_TOKENS`。 */
  maxReasoningTokens?: number;
  /** 思考超過預算後最多重來幾次(整個 run 共用)。預設 1。 */
  maxReasoningRetries?: number;
  signal: AbortSignal;
  emit: (line: RunnerLine) => void;
  now?: () => number;
}

export interface LoopOutcome {
  reason: StopReason;
  /** 最後一輪的全文。 */
  output: string;
  usage: { inputTokens?: number; outputTokens?: number };
}

/** 太長就截,並明說截了多少 —— 模型要知道自己看到的不是全部。 */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[已截斷:原長 ${text.length} 字元,只保留前 ${max}]`;
}

export const omittedNote = (originalChars: number): string => `[舊的工具結果已省略以節省 context:原長 ${originalChars} 字元]`;

/** Compact only old tool results; preserve the latest tool round and all other messages. */
export function fitSdkContext(messages: ModelMessage[], max: number): ModelMessage[] | undefined {
  const copy = structuredClone(messages);
  const size = () => copy.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : m.content.reduce((k, c) => {
    if (c.type === 'text') return k + c.text.length;
    if (c.type === 'tool-call') return k + JSON.stringify(c.input ?? {}).length;
    if (c.type === 'tool-result') {
      const output = c.output;
      return k + ('value' in output ? (typeof output.value === 'string' ? output.value.length : JSON.stringify(output.value).length) : JSON.stringify(output).length);
    }
    return k + JSON.stringify(c).length;
  }, 0)), 0);
  const latest = copy.map(m => m.role).lastIndexOf('assistant');
  for (let i = 0; i < latest && size() > max; i++) {
    const m = copy[i];
    if (m.role !== 'tool') continue;
    for (const c of m.content) {
      if (c.type !== 'tool-result' || !('value' in c.output) || typeof c.output.value !== 'string') continue;
      const original = c.output.value;
      const note = omittedNote(original.length);
      if (note.length < original.length) c.output = { type: c.output.type === 'error-text' ? 'error-text' : 'text', value: note };
    }
  }
  return size() <= max ? copy : undefined;
}

export async function runLoop(o: LoopOptions): Promise<LoopOutcome> {
  const now = o.now ?? Date.now;
  if (!Number.isInteger(o.maxSteps) || o.maxSteps < 1) throw new EngineError('config', 'maxSteps must be a positive integer');
  let messages: ModelMessage[] = [{ role: 'user', content: o.prompt }];
  let stepsUsed = 0;
  let nudged = false;
  let reasoningRetries = 0;
  let lastText = '';
  const usage: LoopOutcome['usage'] = {};
  const addUsage = (u: LoopOutcome['usage']) => {
    for (const key of ['inputTokens', 'outputTokens'] as const) if (u[key] !== undefined) usage[key] = (usage[key] ?? 0) + u[key]!;
  };

  // This outer recovery loop only handles empty answers / reasoning-budget interruption.
  // Tool execution and all normal multi-step roundtrips are owned by streamText.
  while (stepsUsed < o.maxSteps) {
    o.signal.throwIfAborted();
    const inner = new AbortController();
    const relay = () => inner.abort(o.signal.reason);
    o.signal.addEventListener('abort', relay, { once: true });
    let budgetStop: 'reasoning_budget' | 'context_exceeded' | undefined;
    let reasoningChunks = 0;
    let sawOutput = false;
    let currentText = '';
    let currentCalls = 0;
    let finish = 'stop';
    let streamError: unknown;
    const responseMessages: ModelMessage[] = [];
    const starts = new Map<string, number>();
    // AI SDK can execute calls concurrently. Serialize gateway operations to preserve
    // the runner's existing browser/stateful-tool ordering.
    let toolChain: Promise<void> = Promise.resolve();
    const tools = Object.fromEntries(o.tools.schemas.map(schema => [schema.name, tool({
      description: schema.description ?? '', inputSchema: jsonSchema(schema.inputSchema as never),
      execute: async (args, { abortSignal }) => {
        let output!: ToolResult;
        const pending = toolChain.then(async () => {
          (abortSignal ?? inner.signal).throwIfAborted();
          try { output = await o.tools.call(schema.name, args, abortSignal ?? inner.signal); }
          catch (error) {
            if (o.signal.aborted || inner.signal.aborted) throw error;
            output = { ok: false, text: `工具呼叫失敗:${error instanceof Error ? error.message : String(error)}` };
          }
        });
        toolChain = pending.catch(() => {});
        await pending;
        return { ok: output.ok, text: capText(output.text, o.maxToolResultChars) };
      },
      toModelOutput: ({ output }) => ({ type: output.ok ? 'text' : 'error-text', value: output.text }),
    })]));
    try {
      const result = streamText({
        model: o.model, ...(o.system ? { system: o.system } : {}), messages,
        tools, abortSignal: inner.signal, maxRetries: 0,
        ...(o.maxTokens ? { maxOutputTokens: o.maxTokens } : {}),
        stopWhen: stepCountIs(o.maxSteps - stepsUsed),
        prepareStep: ({ messages: next }) => {
          if (stepsUsed > 0 && o.maxContextChars) {
            const fitted = fitSdkContext([...(o.system ? [{ role: 'system' as const, content: o.system }] : []), ...next], o.maxContextChars);
            if (!fitted) { budgetStop = 'context_exceeded'; inner.abort(); return; }
            return { messages: fitted.filter(m => m.role !== 'system') };
          }
        },
        experimental_onStepStart: () => {
          stepsUsed++;
          reasoningChunks = 0; sawOutput = false; currentText = ''; currentCalls = 0;
        },
        onChunk: ({ chunk }) => {
          if (chunk.type === 'reasoning-delta' && o.maxReasoningTokens && !sawOutput && ++reasoningChunks > o.maxReasoningTokens) {
            budgetStop = 'reasoning_budget'; inner.abort();
          }
          if (chunk.type === 'text-delta') {
            if (chunk.text) sawOutput = true;
            currentText += chunk.text;
            o.emit({ t: 'text', chunk: chunk.text });
          }
          if (chunk.type === 'tool-call') {
            sawOutput = true; currentCalls++;
            starts.set(chunk.toolCallId, now());
            o.emit({ t: 'tool-start', id: chunk.toolCallId, name: chunk.toolName, input: chunk.input });
          }
          if (chunk.type === 'tool-result') {
            const output = chunk.output as ToolResult;
            o.emit({ t: 'tool-end', id: chunk.toolCallId, ok: output.ok, elapsedMs: now() - (starts.get(chunk.toolCallId) ?? now()), output: output.text });
          }

        },
        onStepFinish: step => {
          lastText = step.text;
          finish = step.finishReason;
          addUsage(step.usage);
          // The SDK prepares all tool-call and result messages, including invalid calls.
          // Retain them only to support a later recovery request.
          responseMessages.splice(0, responseMessages.length, ...step.response.messages);
        },
        onError: ({ error }) => { streamError ??= error; },
      });
      for await (const part of result.fullStream) {
        if (part.type === 'error') streamError ??= part.error;
        if (part.type === 'tool-error') o.emit({ t: 'tool-end', id: part.toolCallId, ok: false, elapsedMs: now() - (starts.get(part.toolCallId) ?? now()), output: `工具參數或呼叫失敗:${String(part.error)}` });
      }
      await toolChain;
    } catch (error) {
      if (!budgetStop && !o.signal.aborted) streamError ??= error;
    } finally { o.signal.removeEventListener('abort', relay); }
    if (o.signal.aborted) {
      const error = new Error('The operation was aborted'); error.name = 'AbortError'; throw error;
    }
    if (budgetStop === 'context_exceeded') return { reason: budgetStop, output: lastText, usage };
    if (budgetStop === 'reasoning_budget') {
      if (reasoningRetries < (o.maxReasoningRetries ?? 1) && stepsUsed < o.maxSteps) {
        reasoningRetries++;
        messages = [...messages, ...responseMessages, { role: 'user', content: THINK_LESS_NUDGE }];
        continue;
      }
      return { reason: budgetStop, output: currentText, usage };
    }
    if (streamError) {
      const err = streamError as { message?: string; statusCode?: number };
      throw new EngineError('runtime', `模型呼叫失敗:${err.statusCode ? `HTTP ${err.statusCode}: ` : ''}${err.message ?? String(streamError)}`, streamError);
    }
    if (finish === 'length') return { reason: 'max_tokens', output: lastText, usage };
    if (currentCalls > 0) return { reason: 'max_turn_requests', output: lastText, usage };
    if (!lastText.trim() && !nudged && stepsUsed < o.maxSteps) {
      nudged = true;
      // Do not add an empty assistant message: some providers reject it.
      messages = [...messages, ...responseMessages.filter(m => m.role !== 'assistant' || (typeof m.content === 'string' ? m.content.trim() : m.content.some(c => c.type !== 'text' || c.text.trim()))), { role: 'user', content: EMPTY_ANSWER_NUDGE }];
      continue;
    }
    return { reason: 'end_turn', output: lastText, usage };
  }
  return { reason: 'max_turn_requests', output: lastText, usage };
}
