import { createVercelAiCli } from 'agent-engine';
import type { SpawnRuntime, VercelAiCliOptions } from 'agent-engine';

export type VercelAiRuntimeOptions = VercelAiCliOptions;

/** AI SDK tool loop in an Engine-owned subprocess; creation starts no process. */
export function vercelAiRuntime(options: VercelAiRuntimeOptions): SpawnRuntime {
  return createVercelAiCli(structuredClone(options));
}
