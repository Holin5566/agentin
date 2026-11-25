import { createOpenCodeCli } from 'agent-engine';
import type { OpenCodeCliOptions, SpawnRuntime } from 'agent-engine';

export type OpenCodeRuntimeOptions = OpenCodeCliOptions;
export function opencodeRuntime(options: OpenCodeRuntimeOptions = {}): SpawnRuntime {
  return createOpenCodeCli(structuredClone(options));
}
