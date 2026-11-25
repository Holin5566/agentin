#!/usr/bin/env node
/**
 * 端到端測試用的最小上游 MCP server。
 *
 * 四個工具剛好覆蓋三態與取消,測試靠它們區分「gateway 有沒有把語意保住」:
 *   echo   正常回結果
 *   empty  正常完成但查無資料  ← 不是失敗
 *   fail   工具回報失敗        ← 不是查無
 *   slow   拖著,給取消測試用
 *   reject 回 JSON-RPC 錯誤(InvalidParams)← 上游有回話,連線是好的
 *
 * 另外 `secret` 是宣告在 server 上但**不給任何 agent** 的工具,用來驗允許清單:
 * 它不該出現在 tools/list,直接呼叫也該被擋在 gateway,不會轉發到這裡
 * (這支程式會記錄有沒有被呼叫到)。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

const noArgs = { type: 'object', properties: {} };

const server = new Server(
  { name: 'e2e-upstream', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'empty', description: 'always finds nothing', inputSchema: noArgs },
    { name: 'fail', description: 'always fails', inputSchema: noArgs },
    { name: 'slow', description: 'takes a while', inputSchema: noArgs },
    { name: 'reject', description: 'rejects its arguments', inputSchema: noArgs },
    { name: 'secret', description: 'never granted to any agent', inputSchema: noArgs },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echoed: ${req.params.arguments?.text ?? ''}` }] };
    case 'empty':
      // 正常完成,只是沒有符合的資料。**不可以是 isError**。
      return { content: [{ type: 'text', text: '(no matches)' }] };
    case 'fail':
      return { content: [{ type: 'text', text: 'upstream exploded' }], isError: true };
    case 'slow':
      await new Promise((r) => setTimeout(r, 30_000));
      return { content: [{ type: 'text', text: 'finally' }] };
    case 'reject':
      throw new McpError(ErrorCode.InvalidParams, 'bad argument: nope');
    case 'secret':
      // 走到這裡就代表允許清單漏了 —— 讓輸出帶上顯眼字串,測試會抓。
      return { content: [{ type: 'text', text: 'ALLOWLIST_BREACH' }] };
    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

await server.connect(new StdioServerTransport());
