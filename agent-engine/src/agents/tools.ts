import { defineTool, type ToolDecl } from 'mcp-hub';
import type { AgentDefinition } from './manifest.js';
import { EngineError, type SpawnRuntime } from '../types.js';

/** Collect only routes required by these agents and their runtime capabilities. */
export function collectTools(agents: AgentDefinition[], runtime: SpawnRuntime): ToolDecl[] | undefined {
  const routes = new Map<string, ToolDecl>();
  for (const agent of agents) {
    const own = (agent.tools ?? []).filter((tool): tool is ToolDecl => typeof tool !== 'string');
    for (const input of [...own, ...(runtime.gatewayToolDefinitionsFor?.(agent.capabilities) ?? [])]) {
      const tool = defineTool(input);
      const previous = routes.get(tool.id);
      if (previous && ['serverId', 'toolName', 'description', 'timeoutMs', 'maxTotalTimeoutMs'].some(key =>
        previous[key as keyof ToolDecl] !== tool[key as keyof ToolDecl])) {
        throw new EngineError('config', `conflicting tool definition: ${tool.id}`);
      }
      routes.set(tool.id, tool);
    }
  }
  // Legacy string-only manifests continue to use their JSON tool maps.
  return routes.size ? [...routes.values()] : undefined;
}
