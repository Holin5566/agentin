/**
 * Engine 的公開介面。宿主只從這裡匯入。
 *
 * `createAgentEngine()` 建立時不做 IO;每次 take 在 spawn 前驗證與協商,執行期負責
 * 「跑一次」的紀律。業務決策(路由、扇出、reuse、synth、人工 gate)不在這裡。
 */
export type {
  AgentCapabilities,
  ArtifactKey,
  ArtifactRef,
  DraftRef,
  EventMeta,
  RuntimeDecoder,
  RuntimeEvent,
  ArtifactStore,
  CommandContext,
  Engine,
  EngineConfig,
  EngineErrorKind,
  FailureClass,
  PlanEntry,
  RunEvent,
  RuntimeCapabilities,
  SkillAvailability,
  SpawnCommand,
  SpawnRuntime,
  StopReason,
  TakeResult,
  TakeSpec,
  TakeStatus,
  Usage,
} from './types.js';

export { defineTool } from 'mcp-hub';
export type { ToolDecl } from 'mcp-hub';
export { defineAgent } from './agents/manifest.js';
export type { AgentManifest, AgentDefinition } from './agents/manifest.js';
export { EngineError } from './types.js';
export { statusFor, isSalvageable } from './run/status.js';
export { createAgentEngine } from './engine.js';
export { createMemoryStore } from './artifacts/memory.js';
export { createFileStore } from './artifacts/fileStore.js';
export { createSkillChecker, resolveClaudeConfigDir } from './agents/skills.js';
export type { SkillCheckerOpts } from './agents/skills.js';
export type { FileStoreOpts } from './artifacts/fileStore.js';
export { buildRegistry, validateManifests } from './agents/registry.js';
export { openGatewayConfig, createGatewayPool, GATEWAY_ENTRY } from './run/gateway.js';
export { execRuntime } from './run/exec.js';
export { killAllRuntimeGroups } from './run/childGroups.js';
export type { ExecOpts, ExecResult } from './run/exec.js';
export type { GatewaySession } from './run/gateway.js';
export type { AgentRegistry } from './agents/registry.js';
export { claudeCli, createClaudeCli, toolsFor } from './runtimes/claudeCli.js';
export type { ClaudeCliOptions, ExtraMcpServer } from './runtimes/claudeCli.js';
export { GATEWAY_SERVER_NAME } from './shared/names.js';
export { createClaudeDecoder } from './runtimes/claudeStream.js';
export { codexCli, createCodexCli, sandboxFor } from './runtimes/codexCli.js';
export type { CodexCliOptions } from './runtimes/codexCli.js';
export { createVercelAiCli } from './runtimes/vercelAiCli.js';
export type { VercelAiCliOptions } from './runtimes/vercelAiCli.js';
