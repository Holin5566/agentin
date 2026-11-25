#!/usr/bin/env node
/**
 * runner:扮演「`claude -p`」的角色 —— engine 把它當子程序 spawn,prompt 走 stdin,事件從 stdout 讀(JSONL,
 * 見 `protocol.ts`)。內部由 AI SDK `streamText` 跑多步 loop (`loop.ts`),工具透過 engine 寫好的 gateway 設定(`--mcp-config`)連 mcp-hub。
 *
 * 所以對 engine 來說,它跟 claude 沒兩樣:spawn、逾時、取消(process group kill)、產物、事件全沿用。
 * 允許清單在 hub 落實 —— runner 只列得到、也只叫得到被允許的 tool。
 *
 * 金鑰走環境變數 `VERCEL_AI_API_KEY`,不放 argv(`ps` 看得到)。
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_MAX_CONTEXT_CHARS, DEFAULT_MAX_REASONING_TOKENS, runLoop } from './loop.js';
import { mcpChildEnv } from './mcpEnv.js';
import type { ToolPort } from './loop.js';
import { classifyFailure, encodeFailure, encodeLine } from './protocol.js';
import type { RunnerLine } from './protocol.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { createVercelAiModel } from './model.js';
import { EngineError } from '../../types.js';
import type { LoopToolSchema } from './types.js';

/** 單次 tool 呼叫的上限。整個 take 的 wall-clock 預算由 engine 管,這只是防單一工具卡死。 */
const TOOL_TIMEOUT_MS = 10 * 60_000;

interface McpConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

const emit = (line: RunnerLine): void => { process.stdout.write(encodeLine(line)); };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 連上 engine 寫好的 gateway(通常只有一台),把它們的 tool 合成一個 `ToolPort`。 */
async function openTools(configPath: string | undefined): Promise<{ port: ToolPort; close: () => Promise<void> }> {
  const clients: Client[] = [];
  const route = new Map<string, Client>();
  const schemas: LoopToolSchema[] = [];

  if (configPath) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as McpConfig;
    for (const [name, s] of Object.entries(cfg.mcpServers ?? {})) {
      // 不繼承 runner 的環境(裡面有模型金鑰):只給白名單 + 設定檔明列的值,見 `mcpEnv.ts`。
      const env = mcpChildEnv(s.env);
      const client = new Client({ name: `vercel-ai-runner:${name}`, version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: s.command, args: s.args ?? [], env, stderr: 'inherit' }));
      clients.push(client);
      for (const t of (await client.listTools()).tools) {
        route.set(t.name, client);
        schemas.push({ name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema as Record<string, unknown> });
      }
    }
  }

  return {
    port: {
      schemas,
      async call(name, args, signal) {
        const client = route.get(name);
        // 不在清單:交給第一台 gateway 回它自己的拒絕訊息(允許清單的真實來源是 hub);沒有 gateway 就自己講。
        if (!client && clients.length === 0) return { ok: false, text: `沒有可用的工具:${name}` };
        const res = await (client ?? clients[0]).callTool(
          { name, arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> },
          undefined,
          { signal, timeout: TOOL_TIMEOUT_MS },
        );
        const blocks = Array.isArray(res.content) ? res.content : [];
        const text = blocks
          .map((b: { type?: string; text?: string }) => (b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b)))
          .join('\n');
        return { ok: res.isError !== true, text };
      },
    },
    close: async () => { await Promise.allSettled(clients.map((c) => c.close())); },
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      'mcp-config': { type: 'string' },
      'max-steps': { type: 'string' },
      'max-tool-chars': { type: 'string' },
      'max-tokens': { type: 'string' },
      'max-context-chars': { type: 'string' },
      'max-reasoning-tokens': { type: 'string' },
    },
  });
  const kind = values.provider === 'anthropic' ? 'anthropic' : values.provider === undefined || values.provider === 'openai-compat' ? 'openai-compat' : undefined;
  if (!kind) throw new EngineError('config', `不認得的 --provider:${values.provider}`);
  // openai-compat 一定要有端點;anthropic 預設打官方 API。
  if (!values.model || (kind === 'openai-compat' && !values['base-url'])) throw new EngineError('config', '缺少 --base-url 或 --model');

  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => ac.abort());

  const prompt = await readStdin();
  const tools = await openTools(values['mcp-config']);
  try {
    const model = createVercelAiModel({
      provider: kind,
      ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
      model: values.model,
      ...(process.env.VERCEL_AI_API_KEY ? { apiKey: process.env.VERCEL_AI_API_KEY } : {}),
    });
    const outcome = await runLoop({
      model,
      tools: tools.port,
      prompt,
      // 沒有 CLI 替裸模型補「你在哪、能做什麼」,所以由 runner 補一則精簡的 system 訊息(內容與原因見 `systemPrompt.ts`)。
      system: buildSystemPrompt({ toolNames: tools.port.schemas.map((t) => t.name) }),
      maxSteps: Number(values['max-steps'] ?? 30),
      maxToolResultChars: Number(values['max-tool-chars'] ?? 20_000),
      maxContextChars: Number(values['max-context-chars'] ?? DEFAULT_MAX_CONTEXT_CHARS),
      // 預設就開(4000):空轉的代價是 45 秒與整個 token 預算,而正常回合的思考遠低於這個值。原因與取捨見 `loop.ts` 的 `DEFAULT_MAX_REASONING_TOKENS`。
      maxReasoningTokens: Number(values['max-reasoning-tokens'] ?? DEFAULT_MAX_REASONING_TOKENS),
      ...(values['max-tokens'] ? { maxTokens: Number(values['max-tokens']) } : {}),
      signal: ac.signal,
      emit,
    });
    // 補問過仍沒有文字:不能回報成功(下游會拿到一個「ok」卻是空的輸出)。照一般失敗處理,可重試 —— 模型的輸出是非決定性的。
    if (outcome.reason === 'end_turn' && !outcome.output.trim()) {
      throw new EngineError('runtime', '模型沒有給出任何文字回答(補問一次後仍是空白)');
    }
    emit({ t: 'done', reason: outcome.reason, output: outcome.output, usage: outcome.usage });
    return 0;
  } finally {
    await tools.close();
  }
}

main().then(
  (code) => process.stdout.write('', () => process.exit(code)),
  (e) => {
    // 沒有 done 行 = decoder 回 unknown → engine 報 runtime 錯誤,訊息取自 stderr 尾端。
    process.stderr.write(`${(e as Error)?.message ?? String(e)}\n`);
    process.stderr.write(encodeFailure(classifyFailure(e))); // 最後一行:宿主判斷「重試有沒有用」用
    process.stdout.write('', () => process.exit(1));
  },
);
