/**
 * Gateway 的對內型別。純宣告,無 runtime 相依。
 *
 * 三態契約 (見 spec「Tool result contract」):
 *   - 查無資料 → execute 正常回傳,內容表示空結果
 *   - 服務失敗 → throw ToolFailure,gateway 轉成 isError 讓模型看得到
 *   - 使用者取消 → AbortError 一路往上,不是 ToolFailure
 * 把服務失敗壓成「查無資料」會讓 agent 把「RAG 掛了」讀成「沒有這段程式碼」。
 */

/** MCP 要的 JSON Schema 子集 (object 型)。 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface InputSchema {
  [key: string]: unknown;
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface BuiltinTool<Result extends string | CallToolResult = string | CallToolResult> {
  /** MCP 上的工具名 (snake_case),跟 對外 tool id 不同。 */
  name: string;
  description: string;
  inputSchema: InputSchema;
  /** 回傳文字或完整 MCP 結果。signal 必須實際傳進底層,不能只收不用。 */
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<Result>;
}

/** 工具可預期的失敗 (上游掛掉 / 參數不合法)。非預期的 bug 就讓它原樣往上。 */
export class ToolFailure extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/** 對外 tool id → 某台 server 上的某個工具。由 manifests 提供。 */
export interface ToolRoute {
  id: string;
  serverId: string;
  toolName: string;
}
