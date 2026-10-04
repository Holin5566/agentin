/**
 * MCP 公開介面。宿主只從這裡匯入 —— 權限解析(`scope.ts`)、核心(`core.ts`)與
 * 連線組裝(`clients/`)都是內部實作,會改。
 *
 * 要把自己的工具掛進來:實作 `BuiltinTool`,在 `manifests/mcp-servers/` 宣告一台
 * `transport: "in-memory"` 的 server 把 tool id 指到它,再從 `openGateway` 的
 * `builtinTools` 傳進去。走 `claude -p` 的路徑不吃這個,見 README。
 */
export { openGateway, checkServers, ToolCallFailed } from './hub.js';
export type {
  Hub,
  ToolInfo,
  OpenGatewayOpts,
  ToolCallFailureKind,
  ServerCheck,
} from './hub.js';
export { createBuiltinServer } from './builtin/server.js';
export { serveBuiltinStdio } from './builtin/stdio.js';
export type { ServeBuiltinStdioOpts, BuiltinStdioServer } from './builtin/stdio.js';
export { createFsReadTools, globToRegExp } from './tools/fsRead.js';
export type { FsReadOptions } from './tools/fsRead.js';
export { ToolFailure } from './types.js';
export type { BuiltinTool, InputSchema } from './types.js';

// agent-engine 用這些把 agent manifest 的 tools 驗成允許清單,再用 `--tools` 交給 gateway。
export { defineTool, loadCatalog, resolveAllow, MCP_SERVERS_DIR } from './manifest/load.js';
// agent manifest 也是手寫 JSON,同一個「重複 key 靜默後者勝」的坑。
export { duplicateKeys } from './manifest/duplicateKeys.js';
export type { Catalog, ServerDecl, ToolDecl, Transport } from './manifest/load.js';

// 對外可見的識別字串:gateway 的 server 名就是 claude 的工具名前綴。
export { GATEWAY_SERVER_NAME, BUILTIN_SERVER_NAME, PROTOCOL_VERSION } from './shared/names.js';

export type { ToolResult } from './core.js';
