import { createAgentEngine, EngineError } from 'agent-engine';
import type { Engine, EngineConfig, RunEvent, SpawnRuntime, TakeResult, TakeSpec } from 'agent-engine';
import { defineAgent, engineAgent } from './agent.js';
import type { Agent } from './agent.js';

export interface AgentinConfig {
  agents: readonly Agent[];
  runtimes: Readonly<Record<string, SpawnRuntime>>;
  defaultRuntime: string;
  root?: string;
  artifacts?: EngineConfig['artifacts'];
  defaults?: EngineConfig['defaults'];
  env?: EngineConfig['env'];
  onEvent?: (event: RunEvent) => void;
  checkSkill?: EngineConfig['checkSkill'];
  log?: EngineConfig['log'];
  allowExperimentalRuntime?: boolean;
}

export type RunOptions = Omit<TakeSpec, 'agent' | 'prompt'> & {
  agent: string;
  input: string;
  runtime?: string;
};
export type RunResult = TakeResult & { runtime: string };
export interface Agentin {
  run(options: RunOptions): Promise<RunResult>;
  close(): Promise<void>;
}

function budget(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new EngineError('config', `${field} must be a positive finite number`);
  }
}

/** Owns engines, snapshots registration, and delegates execution without fallback. */
export function createAgentin(config: AgentinConfig): Agentin {
  if (!config || !Array.isArray(config.agents) || !config.runtimes || typeof config.runtimes !== 'object') {
    throw new EngineError('config', 'agents and runtimes are required');
  }
  const runtimes = new Map(Object.entries(config.runtimes).map(([name, runtime]) => {
    if (!name.trim() || !runtime || typeof runtime.command !== 'function' || !runtime.capabilities) {
      throw new EngineError('config', `invalid runtime: ${name}`);
    }
    if (runtime.experimental && !config.allowExperimentalRuntime) {
      throw new EngineError('capability', `runtime ${name} is experimental: ${runtime.experimental}`);
    }
    return [name, { ...runtime, capabilities: { ...runtime.capabilities } }] as const;
  }));
  if (!runtimes.has(config.defaultRuntime)) throw new EngineError('config', `unknown default runtime: ${config.defaultRuntime}`);
  budget(config.defaults?.timeoutMs, 'timeoutMs');
  budget(config.defaults?.maxOutputBytes, 'maxOutputBytes');
  const agents = new Map<string, Agent>();
  for (const declaration of config.agents) {
    const agent = defineAgent({ ...declaration, tools: [...declaration.tools], skills: [...declaration.skills], capabilities: { ...declaration.capabilities } });
    if (agents.has(agent.id)) throw new EngineError('config', `duplicate agent: ${agent.id}`);
    if (agent.runtime !== undefined && !runtimes.has(agent.runtime)) throw new EngineError('config', `unknown runtime for ${agent.id}: ${agent.runtime}`);
    agents.set(agent.id, agent);
  }
  const defaultRuntime = config.defaultRuntime;
  const engineConfig: Omit<EngineConfig, 'runtime' | 'agents'> = {
    root: config.root ?? process.cwd(),
    artifacts: config.artifacts,
    defaults: config.defaults ? { ...config.defaults } : undefined,
    env: config.env ? { ...config.env } : undefined,
    onEvent: config.onEvent, checkSkill: config.checkSkill, log: config.log,
    allowExperimentalRuntime: config.allowExperimentalRuntime,
  };
  const engines = new Map<string, Engine>();
  let closed = false;
  let closing: Promise<void> | undefined;

  return {
    async run(options): Promise<RunResult> {
      if (closed) throw new EngineError('config', 'agentin is closed');
      if (!options || typeof options.input !== 'string') throw new EngineError('config', 'input must be a string');
      const agent = agents.get(options.agent);
      if (!agent) throw new EngineError('config', `unknown agent: ${options.agent}`);
      const name = options.runtime ?? agent.runtime ?? defaultRuntime;
      const runtime = runtimes.get(name);
      if (!runtime) throw new EngineError('config', `unknown runtime: ${name}`);
      budget(options.timeoutMs, 'timeoutMs');
      budget(options.maxOutputBytes, 'maxOutputBytes');
      let engine = engines.get(name);
      if (!engine) {
        engine = createAgentEngine({ ...engineConfig, runtime });
        engines.set(name, engine);
      }
      const { agent: _agent, input, runtime: _runtime, ...take } = options;
      // Engine receives a complete prompt; role composition belongs to this SDK layer.
      const prompt = agent.instructions ? `${agent.instructions}\n\n${input}` : input;
      const result = await engine.runTake({ ...take, agent: engineAgent(agent), prompt });
      return { ...result, runtime: name };
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = Promise.allSettled([...engines.values()].map(engine => engine.close())).then(results => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'engine shutdown failed');
      });
      return closing;
    },
  };
}
