/**
 * MCP 協議轉接：tools/list 與 tools/call 委派給共用核心。
 * 對外工具名稱使用 manifest 宣告的 tool id，呼叫結果保留上游欄位。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { GATEWAY_SERVER_NAME, PROTOCOL_VERSION } from './shared/names.js';
import type { ToolCore } from './core.js';

export interface GatewayOpts {
  core: ToolCore;
}

export function createGateway(o: GatewayOpts): McpServer {
  const server = new McpServer(
    { name: GATEWAY_SERVER_NAME, version: PROTOCOL_VERSION },
    { capabilities: { tools: {} } },
  );

  // 走 `.server` 的低階 handler,不用 `registerTool` —— 後者的 inputSchema 只收 Zod
  // (`AnySchema = ZodTypeAny | $ZodType`),而 gateway 要把上游任意的 JSON Schema
  // 原樣轉出去。轉成 Zod 得多一層 converter,而且任何轉不乾淨的欄位都會讓模型
  // 看到跟上游不一致的簽章。proxy 正是 SDK 說的 advanced use case。
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await o.core.list()).map((t) => ({
      name: t.id,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    // `ToolDenied` 直接往上 —— MCP 沒有「這個工具不給你」這種結果型別,它是協議錯誤。
    // 取消與連線失敗同理。工具自己回報的失敗才是 `{ isError: true }`。
    return o.core.call(
      req.params.name,
      req.params.arguments ?? {},
      extra.signal,
    );
  });

  return server;
}
