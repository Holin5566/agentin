import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentCapabilities, SpawnRuntime } from '../types.js';
import { EngineError } from '../types.js';
import { childEnv } from './childEnv.js';
import { createOpenCodeDecoder } from './opencodeStream.js';

export interface OpenCodeCliOptions {
  executable?: string;
  model?: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
}

function validateCapabilities(caps?: AgentCapabilities): void {
  // edit permission does not provide a workspace sandbox; do not advertise it.
  if (caps?.filesystem === 'workspace-write') throw new EngineError('capability', 'opencode does not enforce a workspace-write sandbox');
}

export function createOpenCodeCli(options: OpenCodeCliOptions = {}): SpawnRuntime {
  const opts = structuredClone(options);
  return {
    name: 'opencode-cli',
    capabilities: { skills: false, nativeTools: true, filesystemPolicy: 'tool-list', maxSteps: false },
    validateCapabilities,
    createDecoder: createOpenCodeDecoder,
    command({ prompt, mcpConfigPath, capabilities, model }) {
      validateCapabilities(capabilities);
      const name = `agentin-${randomUUID()}`;
      // Unique per-take agent prevents inherited agent-specific permission overrides.
      const tools: Record<string, boolean> = { '*': false };
      const permission: Record<string, string> = { '*': 'deny', external_directory: 'deny' };
      if (capabilities?.filesystem === 'read-only') {
        for (const tool of ['read', 'glob', 'grep']) { tools[tool] = true; permission[tool] = 'allow'; }
      }
      if (capabilities?.shell) { tools.bash = true; permission.bash = 'allow'; }
      const mcp: Record<string, unknown> = {};
      if (mcpConfigPath) {
        const source = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
        for (const [id, server] of Object.entries(source.mcpServers ?? {}) as [string, any][]) {
          mcp[id] = { type: 'local', command: [server.command, ...(server.args ?? [])], environment: server.env, enabled: true };
          tools[`${id}_*`] = true;
          permission[`${id}_*`] = 'allow';
        }
      }
      return {
        file: opts.executable ?? 'opencode', stdin: prompt,
        args: ['run', '--format', 'json', '--agent', name, ...(model ?? opts.model ? ['--model', (model ?? opts.model)!] : [])],
        env: {
          ...childEnv(opts),
          // SDK-owned policy wins over caller environment overrides.
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: 'disabled', autoupdate: false, mcp, agent: { [name]: { mode: 'primary', tools, permission } } }),
          OPENCODE_PERMISSION: JSON.stringify(permission),
          OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
          OPENCODE_CONFIG: undefined,
          OPENCODE_CONFIG_DIR: undefined,
        },
      };
    },
  };
}
