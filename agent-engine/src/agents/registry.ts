/**
 * Agent registry：載入宣告、交叉驗證、能力協商。
 *
 * engine 用的是 `createLazyRegistry`:**每個 agent 第一次被用到時**才載入並驗證它自己,
 * 驗過就快取。仍然在 spawn 之前擋下 —— 一份需要 claude skill 的 manifest 配上 codex,
 * 會在那個 take 開始前當場炸,而不是十分鐘後才發現空手而回。要在 boot 就全部驗完,
 * 呼叫 `engine.check()`;CI 用 `validateManifests`。
 */
import { join } from 'node:path';
import { loadManifests, loadManifestsLenient, normalizeAgent, validateManifest, type AgentDefinition, type AgentManifest } from './manifest.js';
import { loadCatalog, resolveAllow, type Catalog } from 'mcp-hub';
import { EngineError, type SpawnRuntime } from '../types.js';

export interface AgentRegistry {
  get(id: string): AgentManifest;
  ids(): string[];
  catalog: Catalog;
}

/**
 * inline 宣告跟磁碟上的檔走同一套驗證 —— 否則宿主程式碼裡一個打錯的欄位,會得到磁碟上
 * 會被擋下來的那種「寫著限制、實際全開」的 agent。複製一份再驗,不動宿主傳進來的物件。
 */
function validateInline(inline: AgentDefinition[] = []): AgentManifest[] {
  return inline.map((m, i) => {
    try {
      return normalizeAgent(m, `inline[${i}]`);
    } catch (e: any) {
      throw new EngineError('config', e?.message ?? String(e), e);
    }
  });
}

/** 只挑出指定的 agent。選中的找不到才算錯;沒選到的檔壞掉只附在錯誤訊息裡當線索。 */
function select(o: BuildRegistryOpts): Map<string, AgentManifest> {
  const { manifests, errors } = loadManifestsLenient(o.manifestDir);
  const disk = new Map(manifests.map((m) => [m.id, m]));
  const inline = new Map(validateInline(o.inline).map((m) => [m.id, m]));
  const out = new Map<string, AgentManifest>();
  for (const id of o.agentIds!) {
    if (disk.has(id) && inline.has(id)) {
      throw new EngineError('config', `agent id "${id}" 同時存在於 manifests/ 與 inline 宣告`);
    }
    const found = inline.get(id) ?? disk.get(id);
    if (!found) {
      const hint = errors.length ? `(另有 ${errors.length} 份 manifest 載入失敗:${errors.join(';')})` : '';
      throw new EngineError('config', `沒有 agent "${id}"${hint}`);
    }
    out.set(id, found);
  }
  return out;
}

/**
 * 全量驗證 `<root>/manifests/`:每一份 agent manifest 都載入、工具都對得上 catalog、
 * runtime 都給得起。放在測試 / CI 跑 —— 執行期的 engine 用 `agentIds` 只驗自己要的。
 */
export function validateManifests(o: { root: string; runtime: SpawnRuntime }): string[] {
  return buildRegistry({
    manifestDir: join(o.root, 'manifests'), runtime: o.runtime,
    catalog: () => loadCatalog(join(o.root, 'manifests', 'mcp-servers')),
  }).ids();
}

/**
 * 合併檔案與 inline 宣告。
 *
 * inline 不是「覆寫」而是「另一份」—— id 撞了就報錯。靜默讓某一邊贏,會讓人
 * 改了檔案卻不生效,而那種錯只有在行為不對時才會發現。
 */
function merge(fromDisk: AgentManifest[], inline: AgentDefinition[] = []): Map<string, AgentManifest> {
  const out = new Map<string, AgentManifest>();
  for (const m of fromDisk) out.set(m.id, m);
  for (const m of validateInline(inline)) {
    if (out.has(m.id)) {
      throw new EngineError('config', `agent id "${m.id}" 同時存在於 manifests/ 與 inline 宣告`);
    }
    out.set(m.id, m);
  }
  return out;
}

/**
 * 這個 agent 要的東西,選定的 runtime 給不給得起。
 *
 * 通用的兩條在這裡判;**adapter 專屬的限制則靠「試組一次指令」問出來** ——
 * 例如 codex 表達不了 `shell: false`,那是 `codexCli.command()` 自己知道的事。
 * 與其在這裡再維護一份能力矩陣(兩份同一個事實遲早分岔),不如直接問 adapter。
 */
function negotiate(agent: AgentManifest, runtime: SpawnRuntime, catalog: Catalog): void {
  const where = `agent "${agent.id}"`;

  // 子程序家族拿不到宿主注入的 JS 物件,所以路由到 in-memory server 的工具在
  // 那條路上**不可能**存在。不擋的話,症狀是子程序裡的 gateway 在 tools/list
  // 當場 fail loud —— 訊息會是「server has no tool X」,看不出真正的原因是
  // 「這種工具過不了程序邊界」。要讓 CLI 用到宿主工具,得做成真的 stdio server。
  const inMemory = new Set(
    catalog.servers.filter((s) => s.transport === 'in-memory').map((s) => s.id),
  );
  if (inMemory.size > 0) {
    const unreachable = (agent.tools ?? []).filter((id) => {
      const route = catalog.tools.find((t) => t.id === id);
      return route !== undefined && inMemory.has(route.serverId);
    });
    if (unreachable.length > 0) {
      throw new EngineError(
        'capability',
        `${where} 用到 in-memory server 的工具 [${unreachable.join(', ')}],` +
        `但 runtime "${runtime.name}" 在另一個程序執行 —— 宿主注入的工具傳不過去。` +
        `請把它做成真正的 stdio MCP server。`,
      );
    }
  }

  if (agent.skills?.length && !runtime.capabilities.skills) {
    throw new EngineError(
      'capability',
      `${where} 需要 skill [${agent.skills.join(', ')}],但 runtime "${runtime.name}" 沒有 plugin 機制`,
    );
  }

  const caps = agent.capabilities;
  if (caps && Object.keys(caps).length > 0 && runtime.capabilities.filesystemPolicy === 'none') {
    throw new EngineError(
      'capability',
      `${where} 宣告了 capabilities,但 runtime "${runtime.name}" 無法表達檔案系統限制`,
    );
  }

  try {
    if (runtime.validateCapabilities) {
      // runtime 自己提供「只驗能力」的方法:不會被每次執行才有的參數(模型…)干擾。
      runtime.validateCapabilities(caps);
    } else {
      // 退路:丟一個最小的 context 進去。只要 adapter 覺得這組 capabilities 翻譯不出來,
      // 它會 throw —— 我們要的就是在 init 就看到那個 throw。
      runtime.command({ prompt: '', ...(caps ? { capabilities: caps } : {}) });
    }
  } catch (e) {
    if (e instanceof EngineError) {
      throw new EngineError('capability', `${where}: ${e.message}`, e);
    }
    throw e;
  }
}

export interface BuildRegistryOpts {
  manifestDir: string;
  runtime: SpawnRuntime;
  inline?: AgentDefinition[];
  /** A per-take object is the explicit definition; do not load disk agents. */
  inlineOnly?: boolean;
  /**
   * 只載入並驗證這幾個 agent(磁碟或 inline 的 id)。省略 = 全部,行為跟以前一樣。
   *
   * **故障範圍隔離:** 有指定時,其他 agent 的 manifest 就算格式錯、工具宣告錯,也不影響
   * 這個 engine;選中的 agent 都沒宣告工具時,連 mcp-servers catalog 都不讀。全量驗證
   * 交給 `validateManifests`(放在測試 / CI,不在執行期)。
   */
  agentIds?: string[];
  /** mcp-hub catalog 的來源。函式 = 需要時才讀(沒有 agent 宣告工具就不讀)。 */
  catalog?: Catalog | (() => Catalog);
}

const EMPTY_CATALOG: Catalog = { servers: [], tools: [] };

/**
 * 載入 → 交叉驗證 → 能力協商。任何一步不過就 throw,engine 建不起來。
 *
 * 順序是刻意的:先確定宣告本身合法(id 不重複、工具存在),再問 runtime 給不給得起。
 * 反過來的話,一個打錯字的 tool id 會先被報成能力問題。
 */
export function buildRegistry(o: BuildRegistryOpts): AgentRegistry {
  const byId = o.inlineOnly ? merge([], o.inline) : o.agentIds ? select(o) : merge(loadManifests(o.manifestDir), o.inline);
  const extraTools = (a: AgentManifest): string[] => o.runtime.gatewayToolsFor?.(a.capabilities) ?? [];
  const needsCatalog = !o.agentIds || [...byId.values()].some((a) => (a.tools?.length ?? 0) > 0 || extraTools(a).length > 0);
  const catalog = !needsCatalog ? EMPTY_CATALOG
    : typeof o.catalog === 'function' ? o.catalog() : o.catalog ?? loadCatalog();

  for (const agent of byId.values()) {
    if (agent.tools !== undefined) {
      // 引用不存在的 tool id → 這個 agent 會少一個它以為有的工具,而症狀出現在
      // 很後面(模型說「我沒有這個工具」,但 manifest 明明寫了)。
      try {
        resolveAllow(catalog, agent.tools);
      } catch (e: any) {
        throw new EngineError('config', `agent "${agent.id}": ${e?.message ?? e}`, e);
      }
    }
    negotiate(agent, o.runtime, catalog);

    // runtime 沒有原生工具時,capabilities 靠 gateway 工具表達:併進允許清單。這些 id 必須真的存在 ——
    // 缺了的話,agent 會以為自己能讀檔卻沒有任何工具,症狀出現在很後面。
    const extra = extraTools(agent);
    if (extra.length > 0) {
      try {
        resolveAllow(catalog, extra);
      } catch (e: any) {
        throw new EngineError('config',
          `agent "${agent.id}" 的 capabilities 在 runtime "${o.runtime.name}" 要靠 gateway 工具表達,但 ${e?.message ?? e}` +
          `(請在 manifests/mcp-servers/ 宣告)`, e);
      }
      byId.set(agent.id, { ...agent, tools: [...new Set([...(agent.tools ?? []), ...extra])] });
    }
  }

  return {
    catalog,
    ids: () => [...byId.keys()].sort(),
    get(id: string): AgentManifest {
      const found = byId.get(id);
      if (!found) {
        throw new EngineError('config', `沒有 agent "${id}" —— 已宣告的有 ${[...byId.keys()].sort().join(', ') || '(無)'}`);
      }
      return found;
    },
  };
}

export interface LazyRegistry {
  /** 第一次拿某個 agent 時才載入並驗證它;失敗丟 `EngineError`,**不快取**(修好檔案下次會重試)。 */
  get(id: string): AgentManifest;
  /** 立刻驗證全部(或 `agentIds` 指定的)agent,驗過的一併快取。回傳驗過的 id。 */
  check(): string[];
}

/**
 * 依 agent 延遲載入的 registry。建立時**不做任何 IO**,所以宿主可以在 module 頂層建 engine,
 * import 不會有副作用。
 *
 * **故障範圍 = 一個 agent**:每個 agent 各自走 `buildRegistry({ agentIds: [id] })`
 * (其他檔案寬鬆讀、沒工具就不讀 catalog),一份壞掉的 manifest 只讓那個 agent 的 take
 * 失敗,不拖垮同一個 engine 上的其他 agent —— 共用一個 engine 也保得住隔離。
 */
export function createLazyRegistry(o: BuildRegistryOpts): LazyRegistry {
  const cache = new Map<string, AgentManifest>();
  return {
    get(id: string): AgentManifest {
      const hit = cache.get(id);
      if (hit) return hit;
      if (o.agentIds && !o.agentIds.includes(id)) {
        throw new EngineError('config', `沒有 agent "${id}" —— 這個 engine 只用 ${[...o.agentIds].sort().join(', ') || '(無)'}`);
      }
      const agent = buildRegistry({ ...o, agentIds: [id] }).get(id);
      cache.set(id, agent);
      return agent;
    },
    check(): string[] {
      const registry = buildRegistry(o);
      for (const id of registry.ids()) cache.set(id, registry.get(id));
      return registry.ids();
    },
  };
}
