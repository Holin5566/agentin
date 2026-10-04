import { createClaudeCli } from 'agent-engine';
import type { ClaudeCliOptions, SpawnRuntime } from 'agent-engine';

/** Registers the Engine adapter; no subprocess is started here. */
export function claudeRuntime(options: ClaudeCliOptions = {}): SpawnRuntime {
  return createClaudeCli(structuredClone(options));
}
