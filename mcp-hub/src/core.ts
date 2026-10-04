/**
 * 共用工具核心：權限、路由、呼叫紀錄與取消傳遞。
 * hub.ts 提供程式介面，gateway.ts 提供 MCP 介面，兩者共用此核心。
 * builtin 與外部上游皆透過 registry 的 MCP client 呼叫。
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { OAuthLoginRequired } from './upstream/oauth.js';
import type { ClientRegistry } from './upstream/registry.js';
import type { ToolDecl } from './manifest/load.js';

/** 允許清單外(或根本不存在)。不是「工具失敗」,所以用例外而不是結果。 */
export class ToolDenied extends Error {
  constructor(readonly toolId: string, readonly allow: string[]) {
    super(`tool not available: ${toolId}`);
    this.name = 'ToolDenied';
  }
}

/** SDK 的請求逾時碼(`ErrorCode.RequestTimeout`)。 */
const REQUEST_TIMEOUT = -32001;

/**
 * 逾時跟「連不上」要分開:前者重試前該先想清楚(加時間?縮小任務?),後者重試
 * 本身就是處置。混在一起的話 caller 只能一律重試或一律放棄,兩個都不對。
 */
export function isTimeout(e: unknown): boolean {
  return (e as { code?: unknown })?.code === REQUEST_TIMEOUT;
}

/**
 * 上游要(重新)授權。跟連不上分開:重試不會好,要有人跑 `auth-login`。
 * - `OAuthLoginRequired`:我們的 provider 在 gateway 模式要開瀏覽器時丟的(訊息寫明怎麼修)
 * - `UnauthorizedError`:SDK 的 auth 流程沒拿到授權
 * - HTTP 401:授權流程走完,上游仍然拒絕
 */
export function isAuthFailure(e: unknown): boolean {
  return e instanceof OAuthLoginRequired || e instanceof UnauthorizedError || (e as { code?: unknown })?.code === 401;
}

/**
 * 判準是「上游有沒有回話」,不是錯誤碼清單。`McpError` 代表 server 回了 JSON-RPC
 * 錯誤或 SDK 判定逾時 —— 兩者連線都是通的。transport 真的斷線時丟的是
 * `StreamableHTTPError` / `TypeError: fetch failed` 之類,都不是 `McpError`。
 *
 * 不能把「非取消非逾時」全當壞掉:client 是並行共用的,那樣會因為一個參數打錯
 * 就連累其他正在跑的工具。
 */
export function isConnectionDead(e: unknown): boolean {
  return !(e instanceof McpError);
}

const errorText = (e: unknown): string => (e as Error)?.message ?? String(e);

export interface ToolListing {
  id: string;
  description?: string;
  inputSchema: unknown;
}

/** 完整上游結果；僅補上 content 與 isError 預設值。文字轉換由 hub.ts 負責。 */
export interface ToolResult {
  /** 保留上游的 structuredContent、_meta 與擴充欄位。 */
  [key: string]: unknown;
  content: unknown[];
  isError: boolean;
}

export interface ToolCore {
  list(): Promise<ToolListing[]>;
  /** 取消:`AbortError` 原樣往上丟,不會被當成工具失敗。 */
  call(toolId: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ToolCoreOpts {
  /** 由 `scope.ts` 提供;核心不知道 manifest 長怎樣。 */
  routes: ToolDecl[];
  /** 允許的 對外 tool id。undefined = 不限制(只給 `--all-tools`)。 */
  allow?: string[];
  clients: ClientRegistry;
  runId: string;
  /** 預設寫 stderr —— stdio 的 stdout 是 JSON-RPC,不能污染。 */
  log?: (line: string) => void;
}

export function createToolCore(o: ToolCoreOpts): ToolCore {
  const log = o.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const allowed = o.routes.filter((r) => !o.allow || o.allow.includes(r.id));
  const byId = new Map(allowed.map((r) => [r.id, r]));
  const allowIds = allowed.map((r) => r.id);

  return {
    async list(): Promise<ToolListing[]> {
      // 同一台 server 在一次 list() 內只問一次,不逐 route 問(playwright 16 個
      // route 會變 16 次跨程序往返)。只在單次呼叫內去重,不做長期快取。
      const toolsOf = async (serverId: string): Promise<Map<string, any>> => {
        const client = await o.clients.get(serverId);
        // 跟 call() 共用失效處理,否則上游重啟後重試 list() 會一直卡死連線。
        let upstream;
        try {
          upstream = await client.listTools();
        } catch (e) {
          if (isConnectionDead(e)) o.clients.drop(serverId, client);
          throw e;
        }
        return new Map<string, any>((upstream.tools ?? []).map((t: any) => [t.name, t]));
      };

      // 各台 server 平行問:一台冷啟動慢(uvx 建 venv)不該讓其他台排在它後面等。
      const serverIds = [...new Set(allowed.map((r) => r.serverId))];
      const settled = await Promise.allSettled(serverIds.map(toolsOf));
      const listed = new Map<string, Map<string, any>>();
      const failed = new Map<string, unknown>();
      serverIds.forEach((id, i) => {
        const s = settled[i]!;
        if (s.status === 'fulfilled') listed.set(id, s.value);
        else failed.set(id, s.reason);
      });

      // **連不上的上游只拿掉它自己的工具。** 一台掛掉(jira 未授權、冷啟動逾時)就讓整份清單
      // 失敗的話,同時用 playwright 與 jira 的 agent 會連瀏覽器都沒有。但**全部**連不上時照樣
      // 丟錯:那時 agent 一個工具都沒有,默默跑下去只會產出一份查無實據的報告。
      if (failed.size > 0 && failed.size === serverIds.length) {
        if (failed.size === 1) throw [...failed.values()][0];
        throw new Error(`所有上游都連不上:${[...failed].map(([id, e]) => `${id}: ${errorText(e)}`).join(';')}`,
          { cause: [...failed.values()][0] });
      }
      for (const [id, e] of failed) {
        const omitted = allowed.filter((r) => r.serverId === id).map((r) => r.id);
        log(`[gateway ${o.runId}] tools/list: ${id} 連不上(${errorText(e)})— 略過 ${omitted.join(', ')}`);
      }

      const out: ToolListing[] = [];
      for (const route of allowed) {
        const tools = listed.get(route.serverId);
        if (!tools) continue; // 上游連不上,上面已記錄
        const tool = tools.get(route.toolName);
        if (!tool) {
          // 宣告了但上游沒有 → fail loud。靜默略過會讓 agent 少一個工具卻沒人知道。
          // 跟「上游連不上」不同:那是暫時的,這是 manifest 寫錯,重試也不會好。
          throw new Error(`route ${route.id}: ${route.serverId} has no tool ${route.toolName}`);
        }
        // manifest 有寫 description 就用它 (可針對這個 agent 的語境改寫),否則用上游的。
        out.push({
          id: route.id,
          description: route.description ?? tool.description,
          inputSchema: tool.inputSchema,
        });
      }
      log(`[gateway ${o.runId}] tools/list → ${out.map((t) => t.id).join(', ') || '(none)'}`);
      return out;
    },

    async call(toolId, args = {}, signal): Promise<ToolResult> {
      const route = byId.get(toolId);
      if (!route) {
        log(`[gateway ${o.runId}] tools/call ${toolId} → DENIED`);
        throw new ToolDenied(toolId, allowIds);
      }

      signal?.throwIfAborted();
      const started = Date.now();
      // 提到 try 外面 —— catch 要知道失敗的是「哪一個」client 才能安全丟棄
      // (見 ClientRegistry.drop)。get() 自己失敗時它是 undefined。
      let client: Client | undefined;
      try {
        client = await o.clients.get(route.serverId);
        signal?.throwIfAborted();
        // resetTimeoutOnProgress 讓長動作(慢站導航、影片 finalize)以「多久沒
        // 動靜」而非「總共跑多久」判死 —— 但要靠 onprogress 才生效:SDK 只在
        // options.onprogress 存在時才送出 progressToken,沒給等於沒開。
        // timeout 省略吃 SDK 預設,不在此塞自己的預設值(該寫在 manifest 上)。
        let sawProgress = false;
        const result: any = await client.callTool(
          { name: route.toolName, arguments: args },
          undefined,
          {
            resetTimeoutOnProgress: true,
            onprogress: () => {
              if (sawProgress) return; // 一次呼叫只記一行
              sawProgress = true;
              log(`[gateway ${o.runId}] tools/call ${toolId} — 上游回報進度,逾時改以停滯計算`);
            },
            ...(route.timeoutMs !== undefined ? { timeout: route.timeoutMs } : {}),
            // 進度可無限延長逾時,maxTotalTimeout 是防線(見 ServerDecl.maxTotalTimeoutMs)。
            ...(route.maxTotalTimeoutMs !== undefined
              ? { maxTotalTimeout: route.maxTotalTimeoutMs }
              : {}),
            ...(signal ? { signal } : {}),
          },
        );
        const isError = Boolean(result?.isError);
        log(`[gateway ${o.runId}] tools/call ${toolId} → ${isError ? 'TOOL_ERROR' : 'ok'} ${Date.now() - started}ms`);
        return { ...result, content: result?.content ?? [], isError };
      } catch (e: any) {
        const cancelled = e?.name === 'AbortError' || e?.aborted || signal?.aborted;
        const timedOut = isTimeout(e);

        // streamable-http 的 session 失效時只丟 404,不會觸發 onclose 或清
        // _sessionId —— 沒有這條那個 client 會一直留在快取裡,永遠 404 循環。
        const dead = !cancelled && client !== undefined && isConnectionDead(e);
        if (dead) o.clients.drop(route.serverId, client!);

        const how = cancelled ? 'CANCELLED'
          : timedOut ? 'TIMEOUT'
          : isAuthFailure(e) ? 'AUTH(需要重新授權)'
          : dead ? 'FAILED(連線已丟棄)'
          : 'FAILED';
        log(`[gateway ${o.runId}] tools/call ${toolId} → ${how} ${Date.now() - started}ms`);
        throw e;
      }
    },
  };
}
