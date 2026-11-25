/**
 * 把 manifest 的 `tools` 宣告變成子程序真的看得到的工具面。
 *
 * 產一份 per-take 的 `--mcp-config`,指向 mcp-hub 的 `dist/bin/entry.js --tools <ids>`。
 * 允許清單由 engine 從 agent manifest 算好再交給 hub,所以 CLI 那邊**只**列得到
 * 宣告過的工具 —— 不是 prompt 裡拜託模型別亂用,是協議層根本沒給。
 *
 * 跟已移除的舊 `runner/runtimes/cli.ts` 相比,這版解掉它的兩個限制:
 *   - `root` 是參數而不是模組常數,所以一個程序可以服務多個專案根
 *   - 可以帶 `${VAR}` 的取值進去,而不是賭子程序繼承得到
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GATEWAY_SERVER_NAME } from '../shared/names.js';
import type { ToolDecl, ServerDecl } from 'mcp-hub';
import { EngineError } from '../types.js';

/**
 * gateway 的 stdio 入口:mcp-hub 這包的 build 產物。從 package 解析而不是專案根 ——
 * 它裝在 node_modules 裡,跟宿主的 manifests 不在同一棵樹。
 *
 * 解析 `package.json` 而不是直接解析 `dist/bin/entry.js`:hub 還沒 build 時,後者會在
 * import 當下就丟錯;前者讓 `openGatewayConfig` 回一個講得清楚的 config 錯誤。
 */
export const GATEWAY_ENTRY = join(dirname(require.resolve('mcp-hub/package.json')), 'dist', 'bin', 'entry.js');

export interface GatewaySession {
  /** `undefined` = 這個 agent 沒宣告工具,不需要 gateway。 */
  configPath?: string;
  close(): void;
}

/** 不需要 gateway 時的空 session,讓呼叫端不必分支。 */
const NO_GATEWAY: GatewaySession = { close: () => {} };

export interface OpenGatewayOpts {
  toolDefinitions?: ToolDecl[];
  servers?: ServerDecl[];
  agentId: string;
  /** agent manifest 的 `tools`。空陣列或 undefined = 不開 gateway。 */
  tools?: string[];
  /** 子程序要用哪個專案根找 manifests。 */
  root: string;
  /** 額外塞給子程序的環境變數(`${VAR}` 插值的取值來源)。 */
  env?: Record<string, string | undefined>;
}

export function openGatewayConfig(o: OpenGatewayOpts): GatewaySession {
  if (!o.tools?.length) return NO_GATEWAY;

  if (!existsSync(GATEWAY_ENTRY)) {
    // 靜默失敗的話,CLI 會照跑但少一個工具,而 prompt 已經在叫模型用那個工具 ——
    // 結果是一份「查不到東西卻講得很有把握」的報告,比當場失敗難查得多。
    throw new EngineError('config', `gateway entry 不存在 — ${GATEWAY_ENTRY}(先 build mcp-hub:agent-engine 的 npm run build 會一起帶到)`);
  }

  const dir = mkdtempSync(join(tmpdir(), `agent-engine-${o.agentId}-`));
  const configPath = join(dir, 'mcp.json');
  const args = [GATEWAY_ENTRY, '--tools', o.tools.join(',')];
  if (o.toolDefinitions !== undefined) {
    const routePath = join(dir, 'tools.json');
    writeFileSync(routePath, JSON.stringify(o.toolDefinitions), { encoding: 'utf8', mode: 0o600 });
    args.push('--tool-definitions', routePath);
  }

  if (o.servers?.length) {
    const serverPath = join(dir, 'servers.json');
    writeFileSync(serverPath, JSON.stringify(o.servers), { encoding: 'utf8', mode: 0o600 });
    args.push('--server-definitions', serverPath);
  }

  // 只帶明確要給的,不把整包 process.env 複製進設定檔 —— 那會把憑證寫進
  // /tmp 的一個檔案裡。子程序本來就繼承得到父程序的環境。
  const env: Record<string, string> = { AGENT_ENGINE_ROOT: o.root };
  for (const [k, v] of Object.entries(o.env ?? {})) if (v !== undefined) env[k] = v;

  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      [GATEWAY_SERVER_NAME]: {
        // process.execPath 而不是 'node':宿主跑在哪個 node 上,gateway 就跑在
        // 哪個,不賭子程序的 PATH。
        command: process.execPath,
        // 傳算好的允許清單,不傳 agent id:子程序不必再去磁碟重讀 agent manifest,
        // 所以 `EngineConfig.agents` 的 inline 宣告也拿得到工具。
        args,
        env,
      },
    },
  }, null, 2), 'utf8');

  let closed = false;
  return {
    configPath,
    close: () => {
      if (closed) return;
      closed = true;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉不該擋住收尾 */ }
    },
  };
}

/**
 * 追蹤所有還沒收掉的 session,讓 `engine.close()` 有東西可清。
 *
 * 單一 take 正常結束時會自己 close;這一層是為了「take 在 finally 之前就炸了」
 * 與「宿主直接關 engine」兩種情況 —— 不然 /tmp 會留下一堆設定檔。
 */
export function createGatewayPool() {
  const open = new Set<GatewaySession>();
  return {
    acquire(o: OpenGatewayOpts): GatewaySession {
      const session = openGatewayConfig(o);
      if (!session.configPath) return session; // 沒開東西就不必追蹤
      open.add(session);
      const close = session.close;
      return {
        configPath: session.configPath,
        close: () => { close(); open.delete(session); },
      };
    },
    closeAll(): void {
      for (const s of [...open]) s.close();
      open.clear();
    },
    get size(): number { return open.size; },
  };
}
