import { defineAgent as defineEngineAgent, EngineError } from 'agent-engine';
import type { AgentCapabilities, AgentDefinition } from 'agent-engine';
import { defineTool } from './tools/tool.js';
import type { FunctionTool } from './tools/tool.js';
import type { ToolDecl } from 'mcp-hub';

export interface Agent {
  readonly id: string;
  readonly instructions: string;
  readonly tools: readonly (ToolDecl | FunctionTool | string)[];
  readonly capabilities: Readonly<AgentCapabilities>;
  readonly skills: readonly string[];
  readonly runtime?: string;
}

export interface AgentOptions {
  id: string;
  instructions: string;
  tools?: (ToolDecl | FunctionTool | string)[];
  capabilities?: AgentCapabilities;
  skills?: string[];
  runtime?: string;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Pure role declaration. Omitted native capabilities deny filesystem and shell. */
export function defineAgent(options: AgentOptions): Agent {
  if (!options || typeof options !== 'object') throw new EngineError('config', 'agent must be an object');
  const known = new Set(['id', 'instructions', 'tools', 'capabilities', 'skills', 'runtime']);
  for (const key of Object.keys(options)) {
    if (!known.has(key)) throw new EngineError('config', `unknown agent option: ${key}`);
  }
  if (typeof options.instructions !== 'string') throw new EngineError('config', 'instructions must be a string');
  if (options.runtime !== undefined && (typeof options.runtime !== 'string' || !options.runtime.trim())) {
    throw new EngineError('config', 'agent runtime must be a non-empty name');
  }
  const capabilities = { filesystem: 'none' as const, shell: false, ...options.capabilities };
  if (options.tools !== undefined && !Array.isArray(options.tools)) throw new EngineError('config', 'tools must be an array');
  const tools = (options.tools ?? []).map(tool => {
    if (typeof tool !== 'string' && (!tool || typeof tool !== 'object')) throw new EngineError('config', 'invalid agent tool');
    return typeof tool === 'object' && 'kind' in tool && tool.kind === 'function' ? defineTool(tool as FunctionTool) : tool;
  });
  const ids = tools.map(tool => typeof tool === 'string' ? tool : tool.id);
  if (new Set(ids).size !== ids.length) throw new EngineError('config', 'duplicate agent tool ID');
  let definition: AgentDefinition;
  try {
    const routes: (ToolDecl | string)[] = tools.map(tool => typeof tool === 'object' && 'kind' in tool && tool.kind === 'function' ? { id: tool.id, serverId: 'agentin-host', toolName: tool.id } : tool as ToolDecl | string);
    definition = defineEngineAgent({ id: options.id, tools: routes, capabilities, skills: options.skills ?? [] });
  } catch (error) {
    throw new EngineError('config', (error as Error).message, error);
  }
  return freeze({
    id: definition.id, instructions: options.instructions,
    tools: tools.map((tool, i) => typeof tool === 'object' && 'kind' in tool && tool.kind === 'function' ? tool : definition.tools![i]), capabilities, skills: definition.skills ?? [],
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
  });
}

export function engineAgent(agent: Agent, tools: (ToolDecl | string)[] = agent.tools as (ToolDecl | string)[]): AgentDefinition {
  return defineEngineAgent({ id: agent.id, tools, capabilities: { ...agent.capabilities }, skills: [...agent.skills] });
}
