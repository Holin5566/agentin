/**
 * 依 serverId 延遲建立並重用 MCP client；並行呼叫共用同一次連線建立。
 * builtin 使用 in-memory transport，外部上游由 transports.ts 建立 transport。
 * closeAll() 停止接受新連線，並等待已建立與建立中的連線完成清理。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GATEWAY_SERVER_NAME, PROTOCOL_VERSION } from '../shared/names.js';
import { createBuiltinServer } from '../builtin/server.js';
import type { BuiltinTool } from '../types.js';
import { createExternalTransport } from './transports.js';
import type { EnvSource } from './transports.js';
import type { ServerDecl } from '../manifest/load.js';

/** 單個上游 `close()` 的寬限上限。一個卡住的上游不該讓整個 hub 的關閉永遠不回來
 *  (in-process 宿主呼叫 closeAll() 時沒有 installShutdown 的 process.exit 兜底)。 */
const CLOSE_TIMEOUT_MS = 3000;

/** 讓一個可能卡住的 close 最多等 ms 就當它結束(resolve,不 reject —— 給 allSettled)。 */
function closeWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    p.then(() => {}, () => {}),
    new Promise<void>((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

export interface ClientRegistry {
  get(serverId: string): Promise<Client>;
  /**
   * 丟棄**指定的那個** client,下次 `get()` 重連(見 `core.ts` 何時呼叫)。
   * 一定要指名實例 —— 並行呼叫共用同一個 client 時,只看 serverId 會誤殺
   * 剛建好、可能正被別人用的新連線。不是快取裡那個實例、或沒連過,都是 no-op。
   */
  drop(serverId: string, client: Client): void;
  closeAll(): Promise<void>;
}

async function connect(decl: ServerDecl, env: EnvSource, builtinTools: BuiltinTool[]): Promise<Client> {
  const client = new Client({ name: GATEWAY_SERVER_NAME, version: PROTOCOL_VERSION }, { capabilities: {} });

  try {
    if (decl.transport === 'in-memory') {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const server = createBuiltinServer(builtinTools);
      // server 先 connect —— 它要能收到 client 的 initialize。
      await server.connect(serverSide);
      await client.connect(clientSide);
      return client;
    }

    // 欄位必填性已在 manifest 載入時驗過;這裡只做 ${VAR} 插值與建構。
    // timeout 管的是 initialize 請求 —— stdio 子程序已經起來、還在冷啟動時,等的就是它。
    await client.connect(createExternalTransport(decl, env),
      decl.connectTimeoutMs !== undefined ? { timeout: decl.connectTimeoutMs } : undefined);
    return client;
  } catch (error) {
    // Failed handshakes can leave a spawned upstream alive.
    await closeWithin(client.close(), CLOSE_TIMEOUT_MS);
    throw error;
  }
}

/**
 * `env` 是 `${VAR}` 的取值來源,預設 `process.env`。caller 想針對這一條連線指定
 * 上游位置(例如 playwright 要連桌機的 proxy 還是 h5 的),就從這裡傳 —— 見
 * `openGateway` 的 `env` 說明。
 */
export function createClientRegistry(
  decls: ServerDecl[],
  env: EnvSource = process.env,
  builtinTools: BuiltinTool[] = [],
): ClientRegistry {
  // 注入的工具是一整包發給每一台 in-memory server 的(見 connect)。宣告兩台以上時
  // 「哪台提供哪些工具」就沒有答案 —— 兩台會露出一模一樣的工具面,而各自的 `tools`
  // 表卻可以指向同一個名字。與其讓它靜默成立,不如在這裡擋下來:要分組請改成多個
  // registry,或把工具做成真正的 stdio server。
  if (builtinTools.length > 0) {
    const inMemory = decls.filter((d) => d.transport === 'in-memory').map((d) => d.id);
    if (inMemory.length > 1) {
      throw new Error(
        `注入 builtin 工具時只能宣告一台 in-memory server,目前有 ${inMemory.length} 台:${inMemory.join(', ')}`,
      );
    }
  }
  const byId = new Map(decls.map((d) => [d.id, d]));
  const ready = new Map<string, Client>();
  const pending = new Map<string, Promise<Client>>();
  // drop() 背景關閉連線,但 closeAll() 要等它們收完,否則 entry 可能提早退出
  // 留下孤兒程序。
  const closingDrops = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  return {
    async get(serverId: string): Promise<Client> {
      if (closed) throw new Error('client registry is closed');
      const cached = ready.get(serverId);
      if (cached) return cached;

      const inflight = pending.get(serverId);
      if (inflight) return inflight;

      const decl = byId.get(serverId);
      if (!decl) throw new Error(`server not declared: ${serverId}`);

      const p = connect(decl, env, builtinTools)
        .then(async (c) => {
          if (closed) {
            await closeWithin(c.close(), CLOSE_TIMEOUT_MS);
            throw new Error('client registry is closed');
          }
          // transport 自己關掉時踢出快取(stdio 子程序死掉、SSE 流中斷)。這只是
          // 第二道網:streamable-http 的 session 失效時只丟 404,不觸發 onclose,
          // 那條要靠 core.ts 呼叫失敗時 drop()。這裡只踢出不重連 —— 沒有正在
          // 等的呼叫,預先連好只是白工。
          c.onclose = () => {
            // closeAll() 自己會清 ready,此時不要再動它(正在被迭代)。
            if (!closed && ready.get(serverId) === c) ready.delete(serverId);
          };
          ready.set(serverId, c);
          return c;
        })
        .finally(() => pending.delete(serverId));
      pending.set(serverId, p);
      return p;
    },

    drop(serverId: string, client: Client): void {
      const c = ready.get(serverId);
      // 身分比對跟 onclose 那條同一個道理:只有「還是我認識的那個」才動它。
      if (c !== client) return;
      ready.delete(serverId);
      // 先移除 onclose 再關 —— 不然關的動作會回頭再 delete 一次(無害但多餘),
      // 而且 close() 失敗不該讓 drop() 丟例外:呼叫端正在處理另一個錯誤。
      c.onclose = undefined;
      const closingOne: Promise<void> = c.close()
        .catch(() => {})
        .finally(() => closingDrops.delete(closingOne));
      closingDrops.add(closingOne);
    },

    closeAll(): Promise<void> {
      if (closing) return closing;
      closed = true;
      // 尚在握手的連線完成後由上面的 closed 檢查關閉;等清理完才返回。
      closing = Promise.allSettled([
        ...[...pending.values()].map((p) => closeWithin(p, CLOSE_TIMEOUT_MS)),
        ...[...closingDrops].map((p) => closeWithin(p, CLOSE_TIMEOUT_MS)), // drop() 丟出去還沒關完的,一起等
        ...[...ready.values()].map((c) => closeWithin(c.close(), CLOSE_TIMEOUT_MS)),
      ]).then(() => {});
      ready.clear();
      return closing;
    },
  };
}
