import { EngineError } from 'agent-engine';
import type { BuiltinTool, InputSchema } from 'mcp-hub';

export interface ToolContext {
  signal: AbortSignal;
  agent: string;
  /** SDK bridge run ID, independent of the Engine take ID. */
  runId: string;
}
export interface FunctionTool {
  readonly kind: 'function';
  readonly id: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly execute: (args: Record<string, unknown>, context: ToolContext) => ReturnType<BuiltinTool['execute']>;
}
export function defineTool(options: Omit<FunctionTool, 'kind'>): FunctionTool {
  if (!options || typeof options.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.id) || typeof options.description !== 'string' || typeof options.execute !== 'function' || options.inputSchema?.type !== 'object') {
    throw new EngineError('config', 'invalid function tool definition');
  }
  const schema = structuredClone(options.inputSchema);
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(schema);
  return Object.freeze({ id: options.id, description: options.description, execute: options.execute, kind: 'function', inputSchema: schema });
}
export type FunctionToolResult = Awaited<ReturnType<BuiltinTool['execute']>>;
