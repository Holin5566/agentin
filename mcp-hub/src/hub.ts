/**
 * 程式端工具介面：依 agent manifest 開啟工具範圍，將結果轉為文字與型別化錯誤。
 * 權限、路由與呼叫紀錄由 core.ts 處理；caller 負責呼叫 close() 釋放連線。
 */
import { randomUUID } from 'node:crypto';
import { createClientRegistry } from './upstream/registry.js';
import type { EnvSource } from './upstream/transports.js';
import { createToolCore, isAuthFailure, isConnectionDead, isTimeout, ToolDenied } from './core.js';
import { type Catalog, loadCatalog } from './manifest/load.js';
import { scopeForTools } from './manifest/scope.js';
import type { ToolResult } from './core.js';
import type { BuiltinTool } from './types.js';

export interface ToolInfo {
  id: string;
  description?: string;
  inputSchema: unknown;
}

/** 呼叫失敗。`kind` 讓 caller 分辨該重試、該改參數、還是該放棄。 */
export type ToolCallFailureKind =
  /** 這個 agent 的清單裡沒有這個工具(或工具不存在) */
  | 'denied'
  /** 工具本身回報失敗(上游掛了、參數不合法) */
  | 'tool-error'
  /**
   * 跑太久被砍。**跟 `transport` 分開是刻意的** —— 連不上時重試本身就是處置,
   * 逾時則要先想清楚(給多一點時間?把任務切小?),一律重試只會再等一次。
   */
  | 'timeout'
  /**
   * 上游要重新授權(OAuth 過期或沒登入過)。**重試不會好**,要有人在本機跑 `auth-login`;
   * message 會寫明指令。跟 `transport` 分開,caller 才不會一直重試一個只有人能修的東西。
   */
  | 'auth'
  /**
   * 上游有回話,但回的是 JSON-RPC 錯誤(參數不合法、沒有這個方法…)。連線是好的、**沒有**被丟棄,
   * 原樣重試會得到同一個錯 —— 要改的是請求本身。跟 `transport` 用同一條判準分開(core 的
   * `isConnectionDead`),兩層說的才會是同一件事。
   */
  | 'protocol'
  /** 連線斷了(上游沒回話)。此時該 server 的連線已被丟棄,下次呼叫會重連,重試本身就是處置 */
  | 'transport';

/** core.call 丟出來的錯誤 → caller 該怎麼處置。順序有意義:逾時與授權失敗也可能是 McpError。 */
function failureKind(e: unknown): ToolCallFailureKind {
  if (isTimeout(e)) return 'timeout';
  if (isAuthFailure(e)) return 'auth';
  return isConnectionDead(e) ? 'transport' : 'protocol';
}

export class ToolCallFailed extends Error {
  constructor(
    readonly toolId: string,
    readonly kind: ToolCallFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ToolCallFailed';
  }
}

export interface Hub {
  /** 這個 agent 能用的工具。 */
  list(): Promise<ToolInfo[]>;
  /**
   * 呼叫一個工具。**成功回文字,失敗 throw `ToolCallFailed`** ——
   * 不把 MCP 的 `{ isError, content }` 原樣露出去,那是協議細節,
   * 每個 caller 各自判 `isError` 再從 `content[0].text` 挖字串是在外洩實作。
   */
  call(toolId: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  /** Full MCP content, structuredContent, metadata, and tool-error semantics. */
  callResult(toolId: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface OpenGatewayOpts {
  catalog?: Catalog;
  /** 這條連線的允許清單(對外 tool id)。由呼叫端算好 —— hub 不知道 agent 是什麼。 */
  tools: string[];
  /** 稽核 log 用;省略就自動產一個。 */
  runId?: string;
  /** 每次呼叫記一行。預設寫 stderr。 */
  log?: (line: string) => void;
  /**
   * 覆寫 `${VAR}` 的取值,**疊在 `process.env` 之上**(不是取代 —— 取代會讓這條
   * 連線連 `JIRA_TOKEN` 都拿不到)。
   *
   * 用途:**上游位置是 caller 的職責,不是 hub 的**。manifest 只宣告「playwright
   * 在 `${PLAYWRIGHT_MCP_URL}`」,要連桌機容器(8931)還是 h5(8932),由發動這次
   * run 的人決定。
   *
   * 為什麼不直接讀 `process.env` 就好:stdio entry 一次呼叫一個程序,讀全域沒問題;
   * 但長命的宿主程序裡,兩個並行的 run 共用同一個 `process.env`,後設的會蓋掉
   * 先設的。in-process caller 一律從這裡傳。
   */
  env?: EnvSource;
  /**
   * 宿主提供的工具實作。要掛得上,catalog 裡必須有一台 `transport: "in-memory"` 的
   * server,而且它的 `tools` 表把對外 tool id 指到這裡的 `name` —— 工具仍然要經過
   * manifest 宣告才路由得到,注入的只是實作。
   *
   * **只對 in-process 這條路有效。** 走 `claude -p` 的 take 在另一個程序,傳不了
   * JS 物件;那條路要讓工具成為真正的 stdio server(見 README)。
   */
  builtinTools?: BuiltinTool[];
}

/**
 * content[] → 純文字。非 text 的部分在這裡才被丟掉 —— 核心保留原樣,因為模型那條
 * 需要圖片之類的內容。
 */
function textOf(content: unknown[]): string {
  return content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n');
}

export async function openGateway(o: OpenGatewayOpts): Promise<Hub> {
  // 跟 `entry.js --tools <ids>` 走同一個解析 —— 兩個入口不各自組裝 catalog + 允許清單。
  const { catalog, allow = [] } = scopeForTools(o.tools, o.catalog);
  const runId = o.runId ?? randomUUID().slice(0, 8);
  const env: EnvSource = o.env ? { ...process.env, ...o.env } : process.env;

  const clients = createClientRegistry(catalog.servers, env, o.builtinTools ?? []);
  const core = createToolCore({
    routes: catalog.tools, allow, clients, runId,
    ...(o.log ? { log: o.log } : {}),
  });

  const hub: Hub = {
    async list(): Promise<ToolInfo[]> {
      return (await core.list()).map((t) => ({ id: t.id, description: t.description, inputSchema: t.inputSchema }));
    },

    async call(toolId, args = {}, signal): Promise<string> {
      const result = await hub.callResult(toolId, args, signal);
      if (result.isError) throw new ToolCallFailed(toolId, 'tool-error', textOf(result.content));
      return textOf(result.content);
    },

    async callResult(toolId, args = {}, signal): Promise<ToolResult> {
      let result;
      try {
        result = await core.call(toolId, args, signal);
      } catch (e: any) {
        // 核心只說「不在清單」;這裡加上「你有的是這些」,程式端才好判斷下一步。
        if (e instanceof ToolDenied) {
          throw new ToolCallFailed(toolId, 'denied',
            `允許清單裡沒有 ${toolId};可用:${e.allow.join(', ') || '(無)'}`);
        }
        if (signal?.aborted) throw e; // 取消原樣往上,不包成失敗
        throw new ToolCallFailed(toolId, failureKind(e), e?.message ?? String(e));
      }

      return result;
    },

    async close(): Promise<void> {
      await clients.closeAll();
    },
  };
  return hub;
}

export interface CheckOpts {
  catalog?: Catalog;
  /** 同 `openGateway` 的 `env`:疊在 `process.env` 之上。 */
  env?: EnvSource;
  /**
   * 只撥這幾台。撥號有代價(`uvx mcp-atlassian` 冷啟動 30-60s、缺 token 的選配
   * 上游會噴一整排無關的錯),所以要能只驗正在接的那一台。
   * 未宣告的 id 直接報錯 —— 打錯字靜默變成「什麼都沒驗」是最糟的失敗方向。
   */
  only?: string[];
}

export interface ServerCheck {
  id: string;
  transport: string;
  ok: boolean;
  /** 上游 `tools/list` 的數量。 */
  upstreamTools?: number;
  /** 上游實際有的工具名。寫 `manifests/mcp-servers/*.json` 的 `tools` 表就是照這份抄,不要用猜的。 */
  upstreamNames?: string[];
  /** 該 server manifest 的 `tools` 表指到的上游工具名。 */
  declared: string[];
  /** 宣告了但上游沒有 —— 這是 `getJiraIssue` vs `jira_get_issue` 那類錯字的照妖鏡。 */
  missing: string[];
  error?: string;
}

/**
 * 撥號每一台宣告的 server,比對宣告的工具在上游真的存在。
 *
 * gateway 自己在 `tools/list` 時也會 fail loud,但那要等到有人真的去 list 才會發現;
 * 這支是主動檢查,給 syscheck 與換機驗證用。缺憑證的上游會以 `ok: false` 回報,
 * 不 throw —— 有些上游本來就是選配。
 */
export async function checkServers(opts: CheckOpts = {}): Promise<ServerCheck[]> {
  const { servers, tools } = opts.catalog ?? loadCatalog();
  const env: EnvSource = opts.env ? { ...process.env, ...opts.env } : process.env;
  const out: ServerCheck[] = [];

  let targets = servers;
  if (opts.only) {
    const known = new Set(servers.map((s) => s.id));
    const unknown = opts.only.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(
        `server 未宣告:${unknown.join(', ')} —— 已宣告的有 ${[...known].join(', ')}`,
      );
    }
    const want = new Set(opts.only);
    targets = servers.filter((s) => want.has(s.id));
  }

  for (const decl of targets) {
    const declared = tools.filter((t) => t.serverId === decl.id).map((t) => t.toolName);
    const row: ServerCheck = { id: decl.id, transport: decl.transport, ok: false, declared, missing: [] };
    const clients = createClientRegistry([decl], env);
    try {
      const client = await clients.get(decl.id);
      const upstream = (await client.listTools()).tools ?? [];
      const names = new Set<string>(upstream.map((t: any) => t.name));
      row.ok = true;
      row.upstreamTools = upstream.length;
      row.upstreamNames = [...names].sort();
      row.missing = declared.filter((n) => !names.has(n));
    } catch (e: any) {
      row.error = e?.message ?? String(e);
    } finally {
      await clients.closeAll();
    }
    out.push(row);
  }
  return out;
}
