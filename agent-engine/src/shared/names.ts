/**
 * 對外可見的識別字串,由 mcp-hub 擁有 —— gateway 的 server 名就是 claude 的工具名
 * 前綴(`mcp__<name>__<tool id>`),改它等於改模型看到的工具名。
 *
 * 這裡只轉出去,讓 engine 內部與宿主(`agent-engine` 的 index)沿用原本的匯入路徑。
 */
export { GATEWAY_SERVER_NAME, BUILTIN_SERVER_NAME, PROTOCOL_VERSION } from 'mcp-hub';
