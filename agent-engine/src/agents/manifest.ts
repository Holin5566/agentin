import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool, type ToolDecl, duplicateKeys } from 'mcp-hub';
import { PROJECT_ROOT } from '../shared/paths.js';

export interface FlowDecl { id: string; handlerKey: string }
export interface InteractionDecl { id: string; handlerKey: string }
export interface AgentPermission { channels: '*' | string[]; csd?: { forceBug: boolean } }
export interface AgentBackend { default: 'claude-cli' | 'openai-compat' | 'anthropic' }

/**
 * 這個 agent 能碰什麼。**寫意圖,不寫旗標。**
 *
 * 同一個意圖在不同 runtime 是完全不同的東西:claude 是工具名單(`--tools`),
 * codex 是沙箱等級(`-s read-only`),裸接家族根本沒有原生工具。所以 manifest
 * 只說「要什麼」,翻譯是各 runtime adapter 的事。
 *
 * **宣告了就是一份完整聲明:沒寫到的一律不給。** `{ shell: true }` 是「只能跑
 * shell,連讀檔都不行」,不是「可以跑 shell,其餘照舊」—— 權限邊界的預設方向
 * 只能是收緊,不然漏寫一個欄位就是默默開一個洞。
 *
 * 完全不宣告 = 不限制(目前的行為)。
 */
export interface AgentCapabilities {
  /** `none` 連讀都不行;`read-only` 只讀;`workspace-write` 可寫工作目錄。 */
  filesystem?: 'none' | 'read-only' | 'workspace-write';
  /** 可否執行 shell 指令。 */
  shell?: boolean;
}

const FILESYSTEM_LEVELS = ['none', 'read-only', 'workspace-write'];

export interface AgentManifest {
  id: string;
  /** 純 subagent 沒有對外入口,可省略;載入後一律補成空陣列。 */
  flows: FlowDecl[];
  interactions: InteractionDecl[];
  permission?: AgentPermission;
  backend?: AgentBackend;
  /**
   * 正規化後的 gateway tool id；程式定義保留工具物件，engine 接線時才轉換。
   * engine 會對 catalog 交叉檢查，gateway 再執行這份允許清單。
   */
  tools?: string[];
  /**
   * 這個 agent 能碰什麼(見 `AgentCapabilities`)。
   *
   * 由 runtime adapter 翻譯:claude 是 `--tools` 名單(`toolsFor`),codex 是沙箱等級(`sandboxFor`)。
   * 翻譯不出來的組合在建立 engine 時就被能力協商擋下(見 `registry.ts` 的 `negotiate`)。
   */
  capabilities?: AgentCapabilities;
  // ── 以下是 Take(`engine.ts`)要的欄位 ─────────────────────────────────
  // 沒有 prompt 欄位:prompt 是業務的,由宿主組好放進 `TakeSpec.prompt`(見 docs/engine-contract.md)。
  // manifest 只放 engine 會強制執行的東西。
  /**
   * 產出歸在哪個名字底下(結果的 `name` 與 `sub-<name>.md` / `.partial.log` 檔名),
   * 省略 = `id`。`elk-journey` 用它歸回 `elk-investigator` —— journey 是同一個 angle
   * 的另一種拍法,不該在 evidence 目錄裡多長一個檔名。
   */
  reportAs?: string;
  /**
   * 跑之前要確認裝好的 skill plugin 短名(`elk` / `qland` / `prometheus`)。
   * 沒裝就 fail-fast,不要 spawn 一個註定空手撐到 timeout 的子程序。
   */
  skills?: string[];
}

export const MANIFEST_DIR = join(PROJECT_ROOT, 'manifests');

function strArray(v: any, file: string, field: string): string[] {
  if (!Array.isArray(v) || !v.every((s: unknown) => typeof s === 'string'))
    throw new Error(`manifest ${file}: ${field} must be an array of strings`);
  return v as string[];
}

/**
 * 未知欄位也要擋。`{ filesytem: "read-only" }` 打錯字若被靜默忽略,就會變成一個
 * 「manifest 上寫著限制、實際上全開」的 agent —— 權限邊界的失敗方向只能往嚴。
 */
function validateCapabilities(v: unknown, file: string): void {
  const where = `manifest ${file}: capabilities`;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where} 必須是物件`);
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (key === 'filesystem') {
      if (typeof value !== 'string' || !FILESYSTEM_LEVELS.includes(value)) {
        throw new Error(`${where}.filesystem 必須是 ${FILESYSTEM_LEVELS.join(' / ')},收到 ${String(value)}`);
      }
    } else if (key === 'shell') {
      if (typeof value !== 'boolean') throw new Error(`${where}.shell 必須是 boolean`);
    } else {
      throw new Error(`${where}: 未知欄位 "${key}" —— 可用:filesystem / shell`);
    }
  }
}

/**
 * 最上層也不收未知欄位,理由同 `validateCapabilities`:`"capabilites"` 打錯字若被忽略,
 * 就是一個 manifest 上寫著限制、實際上完全不限制的 agent。
 */
const KNOWN_FIELDS = new Set([
  'id', 'flows', 'interactions', 'permission', 'backend', 'tools',
  'capabilities', 'reportAs', 'skills',
]);

/**
 * `id` 會進 gateway 暫存目錄名,`reportAs`(省略時是 `id`)會進產物路徑。跟 fileStore 的
 * 路徑片段同一套白名單,在載入時就擋,不要等 agent 跑完、存檔時才炸。
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkName(value: string, file: string, field: string): void {
  if (!SAFE_NAME.test(value) || value.includes('..'))
    throw new Error(`manifest ${file}: ${field} 只能用英數字與 . _ -(且不含 ..),收到 ${JSON.stringify(value)}`);
}

/** 驗證一份 agent manifest 並補上預設值。磁碟上的檔與 `EngineConfig.agents` 的 inline 宣告共用。 */
export function validateManifest(m: any, file: string): AgentManifest {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`manifest ${file}: 必須是物件`);
  if (typeof m.id !== 'string' || !m.id) throw new Error(`manifest ${file}: missing string id`);
  checkName(m.id, file, 'id');
  const unknown = Object.keys(m).filter((k) => !KNOWN_FIELDS.has(k));
  if (unknown.length) {
    throw new Error(`manifest ${file}: 未知欄位 ${unknown.map((k) => `"${k}"`).join(', ')} —— 可用:${[...KNOWN_FIELDS].join(' / ')}`);
  }
  // flows / interactions 可省略 —— 純 subagent 沒有對外入口,只有 prompt + tools。
  // 缺欄位補空陣列,但寫錯型別仍要 fail loud (少一個 flow 比啟動失敗難查得多)。
  if (m.flows === undefined) m.flows = [];
  if (m.interactions === undefined) m.interactions = [];
  if (!Array.isArray(m.flows)) throw new Error(`manifest ${file}: flows must be an array`);
  if (!Array.isArray(m.interactions)) throw new Error(`manifest ${file}: interactions must be an array`);
  for (const f of m.flows) {
    if (typeof f?.id !== 'string' || typeof f?.handlerKey !== 'string')
      throw new Error(`manifest ${file}: each flow needs {id, handlerKey}`);
  }
  for (const i of m.interactions) {
    if (typeof i?.id !== 'string' || typeof i?.handlerKey !== 'string')
      throw new Error(`manifest ${file}: each interaction needs {id, handlerKey}`);
  }
  if (m.tools !== undefined) strArray(m.tools, file, 'tools');
  if (m.skills !== undefined) strArray(m.skills, file, 'skills');
  if (m.capabilities !== undefined) validateCapabilities(m.capabilities, file);
  if (m.reportAs !== undefined && typeof m.reportAs !== 'string')
    throw new Error(`manifest ${file}: reportAs must be a string`);
  if (m.reportAs !== undefined) checkName(m.reportAs, file, 'reportAs');
  return m as AgentManifest;
}

/** 欄位說明檔,葉節點放的是用途描述不是值 —— 當配置讀會產生一個 id 是說明文字的假 agent。 */
const EXAMPLE = 'example.json';

/**
 * 兩處都讀:`manifests/*.json` 與 `manifests/agents/*.json`。`agents/` 是放 agent
 * 宣告的地方,最上層留給宿主既有的檔案配置(搬遷期間兩處並存)。
 */
const AGENTS_SUBDIR = 'agents';

function jsonFilesIn(dir: string, label: string): Array<{ label: string; path: string }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e: any) {
    // 只有「不存在」算沒有宣告;權限等問題往上丟,不要讓 agent 靜默消失。
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
  return names
    .filter((f) => f.endsWith('.json') && f !== EXAMPLE)
    .sort()
    .map((f) => ({ label: `${label}${f}`, path: join(dir, f) }));
}

/**
 * 讀 `<dir>/*.json` 與 `<dir>/agents/*.json`。兩處共用同一個 id 命名空間,
 * 重複時指出是哪兩個檔 —— 搬檔到 agents/ 卻忘了刪舊的,是最容易犯的錯。
 */
export function loadManifests(dir: string): AgentManifest[] {
  const files = [
    ...jsonFilesIn(dir, ''),
    ...jsonFilesIn(join(dir, AGENTS_SUBDIR), `${AGENTS_SUBDIR}/`),
  ];
  const out: AgentManifest[] = [];
  const seen = new Map<string, string>();
  for (const { label, path } of files) {
    const m = loadOne(path, label); // malformed JSON / 欄位錯都在這裡 throw (fail-loud)
    const prev = seen.get(m.id);
    if (prev) throw new Error(`duplicate agent id "${m.id}" (${prev} 與 ${label})`);
    seen.set(m.id, label);
    out.push(m);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function loadOne(path: string, label: string): AgentManifest {
  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text);
  // `"tools"` 寫了兩次的話 JSON.parse 靜默留後者 —— 前一份允許清單就這樣消失了。
  const dup = duplicateKeys(text);
  if (dup.length) throw new Error(`manifest ${label}: 重複的 key ${dup.map((k) => `"${k}"`).join(', ')}`);
  return validateManifest(parsed, label);
}

/**
 * 同 `loadManifests`,但**一個檔壞掉不影響其他檔**:錯誤收進 `errors` 回給呼叫端。
 *
 * 給「只用其中幾個 agent」的 engine 用 —— 不相干的 manifest 寫錯,不該讓它起不來。
 * 重複的 id 兩份都不收(不知道哪份才對),並記一筆錯誤。完整驗證用 `loadManifests`。
 */
export function loadManifestsLenient(dir: string): { manifests: AgentManifest[]; errors: string[] } {
  const files = [
    ...jsonFilesIn(dir, ''),
    ...jsonFilesIn(join(dir, AGENTS_SUBDIR), `${AGENTS_SUBDIR}/`),
  ];
  const byId = new Map<string, { m: AgentManifest; label: string }>();
  const dup = new Set<string>();
  const errors: string[] = [];
  for (const { label, path } of files) {
    try {
      const m = loadOne(path, label);
      const prev = byId.get(m.id);
      if (prev) { dup.add(m.id); errors.push(`duplicate agent id "${m.id}" (${prev.label} 與 ${label})`); continue; }
      byId.set(m.id, { m, label });
    } catch (e: any) {
      errors.push(`${label}: ${e?.message ?? e}`);
    }
  }
  const manifests = [...byId.values()].filter(({ m }) => !dup.has(m.id)).map(({ m }) => m);
  return { manifests: manifests.sort((a, b) => a.id.localeCompare(b.id)), errors };
}

/** Code definitions preserve route objects until the engine boundary. */
export type AgentDefinition = Omit<AgentManifest, 'tools'> & { tools?: (ToolDecl | string)[] };

export function normalizeAgent(input: AgentDefinition, label = `agent(${input.id})`): AgentManifest {
  const tools = input.tools?.map(tool => typeof tool === 'string' ? tool : defineTool(tool).id);
  return validateManifest({ ...structuredClone(input), ...(tools ? { tools } : {}) }, label);
}

export function defineAgent(input: Omit<AgentDefinition, 'flows' | 'interactions'> & Partial<Pick<AgentDefinition, 'flows' | 'interactions'>>): AgentDefinition {
  normalizeAgent({ ...input, flows: input.flows ?? [], interactions: input.interactions ?? [] });
  return { ...structuredClone(input), flows: input.flows ?? [], interactions: input.interactions ?? [] };
}
