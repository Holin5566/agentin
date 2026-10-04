/**
 * loop 與 runner 共用的型別。只在 vercelAi 這包裡流動,不進 engine 的公開型別:
 * engine 看到的 runtime 仍是 `SpawnRuntime`(見 `../vercelAiCli.ts`),loop 跑在 runner 子程序裡。
 */

/** 給模型看的 tool schema。`inputSchema` 是 JSON Schema(MCP 的 tool 本來就是)。 */
export interface LoopToolSchema {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
