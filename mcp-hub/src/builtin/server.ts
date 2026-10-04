/**
 * 宿主注入的工具所掛的 MCP server。透過 in-memory transport 掛進 gateway,所以
 * gateway 眼裡它跟外部 server 沒有差別 —— `tools/call` 不需要 code / mcp 分支。
 */
import Ajv from 'ajv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BUILTIN_SERVER_NAME, PROTOCOL_VERSION } from '../shared/names.js';
import { ToolFailure, type BuiltinTool } from '../types.js';

/**
 * 套件自己不帶任何工具 —— 這裡永遠是空的。工具由宿主經
 * `openGateway({ builtinTools })` 或 `createClientRegistry(..., builtinTools)` 注入。
 */
export const BUILTIN_TOOLS: BuiltinTool[] = [];

export function createBuiltinServer(tools: BuiltinTool[] = BUILTIN_TOOLS): McpServer {
  const byName = new Map(tools.map((t) => [t.name, t]));
  if (byName.size !== tools.length) throw new Error('duplicate builtin tool name');
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validators = new Map(tools.map((t) => [t.name, ajv.compile(t.inputSchema)]));

  const server = new McpServer(
    { name: BUILTIN_SERVER_NAME, version: PROTOCOL_VERSION },
    { capabilities: { tools: {} } },
  );

  // 跟 gateway 同樣走 `.server` 的低階 handler:`registerTool` 的 inputSchema 只收 Zod,
  // 而 `BuiltinTool` 刻意用 JSON Schema 宣告 (types.ts 無 runtime 相依)。要改用高階
  // API 就得把 zod 變成直接相依、並把兩支工具的手寫驗證換成 schema —— 那是另一件事。
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = byName.get(req.params.name);
    // 不存在的工具是協議層錯誤 (caller 用了沒公布的名字),不是工具失敗。
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);

    try {
      const args = req.params.arguments ?? {};
      const validate = validators.get(tool.name)!;
      if (!validate(args)) throw new ToolFailure(`Invalid arguments: ${ajv.errorsText(validate.errors)}`);
      extra.signal.throwIfAborted();
      const result = await tool.execute(args, extra.signal);
      return typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result;
    } catch (e: any) {
      // 取消往上丟 —— 它不是「工具回報失敗」,是這次呼叫沒有結果。
      if (e?.name === 'AbortError' || e?.aborted || extra.signal?.aborted) throw e;
      if (e instanceof ToolFailure) {
        const text = e.detail ? `${e.message}\n(${e.detail})` : e.message;
        return { content: [{ type: 'text', text }], isError: true };
      }
      throw e; // 非預期的 bug 不要偽裝成工具失敗
    }
  });

  return server;
}
