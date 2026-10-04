import { defineAgent as defineEngineAgent, EngineError } from 'agent-engine';
import type { AgentCapabilities, AgentDefinition } from 'agent-engine';
import type { ToolDecl } from 'mcp-hub';

export interface Agent {
  readonly id: string;
  readonly instructions: string;
  readonly tools: readonly (ToolDecl | string)[];
  readonly capabilities: Readonly<AgentCapabilities>;
  readonly skills: readonly string[];
  readonly runtime?: string;
}

export interface AgentOptions {
  id: string;
  instructions: string;
  tools?: (ToolDecl | string)[];
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
  let definition: AgentDefinition;
  try {
    definition = defineEngineAgent({ id: options.id, tools: options.tools ?? [], capabilities, skills: options.skills ?? [] });
  } catch (error) {
    throw new EngineError('config', (error as Error).message, error);
  }
  return freeze({
    id: definition.id, instructions: options.instructions,
    tools: definition.tools ?? [], capabilities, skills: definition.skills ?? [],
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
  });
}

export function engineAgent(agent: Agent): AgentDefinition {
  return defineEngineAgent({ id: agent.id, tools: [...agent.tools], capabilities: { ...agent.capabilities }, skills: [...agent.skills] });
}
