/**
 * AI SDK model adapter (OpenAI-compatible / Anthropic) for the SDK-managed loop in loop.ts.
 * A stream error after complete tool calls is normalized so those calls remain usable.
 */
import { wrapLanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { EngineError } from '../../types.js';

// ─── Adapter ─────────────────────────────────────────────────────────────

/** 模型從哪來:OpenAI 相容 API(bifrost / ollama)或 Anthropic API(直連)。 */
export type VercelAiProviderKind = 'openai-compat' | 'anthropic';

export interface VercelAiModelOptions {
  /** 預設 `openai-compat`。`anthropic` 走 Anthropic Messages API(`x-api-key`)。 */
  provider?: VercelAiProviderKind;
  /**
   * `openai-compat`:API 的根(含 `/v1`),**必填**。
   * `anthropic`:省略 = `https://api.anthropic.com/v1`;測試或走代理時才給。
   */
  baseUrl?: string;
  /**
   * `openai-compat`:原樣當 Bearer token 送。bifrost 的 virtual key 帶 `sk-bf-` 前綴 —— 前綴由呼叫端補。
   * `anthropic`:當 `x-api-key` 送。
   */
  apiKey?: string;
  model: string;
}

export function createVercelAiModel(opts: VercelAiModelOptions) {
  const modelId = opts.model;
  const kind = opts.provider ?? 'openai-compat';
  if (kind === 'openai-compat' && !opts.baseUrl) throw new EngineError('config', 'openai-compat 需要 baseUrl');
  const model = kind === 'anthropic'
    ? createAnthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) })(modelId)
    : createOpenAICompatible({ name: 'openai-compat', baseURL: opts.baseUrl!, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) }).chatModel(modelId);
  return wrapLanguageModel({ model, middleware: {
    specificationVersion: 'v3',
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      let calls = 0;
      let recovered = false;
      let finished = false;
      let pendingError: unknown;
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === 'tool-call') calls++;
          if (part.type === 'error') { pendingError = part.error; return; }
          if (part.type === 'finish') {
            finished = true;
            if (pendingError && calls > 0) {
              recovered = true;
              const error = pendingError as { message?: string };
              process.stderr.write(`[vercel-ai] 串流在收到 ${calls} 個 tool call 之後出錯,仍交出已收到的 call:${error?.message ?? String(pendingError)}\n`);
              part = { ...part, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } };
            } else if (pendingError) controller.enqueue({ type: 'error', error: pendingError });
          }
          controller.enqueue(part);
        },
        flush(controller) {
          if (!finished && pendingError) {
            if (calls > 0) {
              recovered = true;
              const error = pendingError as { message?: string };
              process.stderr.write(`[vercel-ai] 串流在收到 ${calls} 個 tool call 之後出錯,仍交出已收到的 call:${error?.message ?? String(pendingError)}\n`);
            } else controller.enqueue({ type: 'error', error: pendingError });
          }
          if (recovered && !finished) controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: undefined, text: undefined, reasoning: undefined } } });
        },
      })) };
    },
  } });
}
