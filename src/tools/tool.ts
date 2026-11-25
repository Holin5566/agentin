import { EngineError } from 'agent-engine';
import type { BuiltinTool, InputSchema } from 'mcp-hub';
import { ToolFailure } from 'mcp-hub';
import { z } from 'zod/v4';

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
export interface ZodToolOptions<S extends z.ZodType> {
  id: string;
  description: string;
  inputSchema: S;
  execute: (args: z.output<S>, context: ToolContext) => ReturnType<BuiltinTool['execute']>;
}
export function defineTool<S extends z.ZodType>(options: ZodToolOptions<S>): FunctionTool;
export function defineTool(options: Omit<FunctionTool, 'kind'>): FunctionTool;
export function defineTool(options: Omit<FunctionTool, 'kind'> | ZodToolOptions<z.ZodType>): FunctionTool {
  const validator = options?.inputSchema instanceof z.ZodType ? options.inputSchema : undefined;
  let inputSchema: InputSchema;
  try {
    inputSchema = validator ? z.toJSONSchema(validator, { io: 'input', target: 'draft-7' }) as InputSchema : options?.inputSchema as InputSchema;
  } catch (error) {
    throw new EngineError('config', 'tool schema cannot be represented as JSON Schema', error);
  }
  if (!options || typeof options.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.id) || typeof options.description !== 'string' || typeof options.execute !== 'function' || inputSchema?.type !== 'object') {
    throw new EngineError('config', 'invalid function tool definition');
  }
  const schema = structuredClone(inputSchema);
  const implementation = options.execute;
  const execute: FunctionTool['execute'] = validator ? async (args, context) => {
    context.signal.throwIfAborted();
    const parsed = await validator.safeParseAsync(args);
    context.signal.throwIfAborted();
    if (!parsed.success) throw new ToolFailure(`Invalid tool arguments: ${parsed.error.message}`);
    return implementation(parsed.data as Record<string, unknown>, context);
  } : implementation as FunctionTool['execute'];
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(schema);
  return Object.freeze({ id: options.id, description: options.description, execute, kind: 'function', inputSchema: schema });
}
export type FunctionToolResult = Awaited<ReturnType<BuiltinTool['execute']>>;
