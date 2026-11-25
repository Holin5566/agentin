/**
 * 對外可見的識別字串。集中在一處,因為它們會外洩到使用者寫的東西裡。
 *
 * `GATEWAY_SERVER_NAME` 是 `--mcp-config` 的 server key,claude 會用它當工具名前綴
 * (`mcp__<name>__<tool id>`)。**改它等於改模型看到的工具名** —— prompt 裡如果點名
 * 了工具,那些字串會一起失效,所以它不該散在各個檔案裡各寫一次。
 */

/** MCP gateway 的 server 名 = claude 的工具名前綴。 */
export const GATEWAY_SERVER_NAME = 'agent-engine-gateway';

/** 內建工具 server 的自我識別名(不影響工具名前綴 —— 它掛在 gateway 後面)。 */
export const BUILTIN_SERVER_NAME = 'agent-engine-builtin';

/** 這包程式在 MCP 握手時的版本號。 */
export const PROTOCOL_VERSION = '0.1.0';
