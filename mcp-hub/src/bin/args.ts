/**
 * **argv → 參數**,就這件事。跟 `entry.ts` 分開是因為 entry 一被 import 就會啟動
 * server —— 測試只想拿 parseArgs 也會真的起一個 gateway 掛在 stdin 上。
 * 這裡保持純函式,沒有任何副作用。
 *
 * 實際的範圍解析(允許清單 → 驗證、組 catalog)在 `scope.ts`,兩個入口共用 ——
 * 那是 manifest 邏輯,不該讓程式介面去依賴命令列模組。
 *
 * hub 不知道 agent 是什麼:允許清單由呼叫端(engine)算好再傳進來。
 */
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../manifest/load.js';
import { scopeForTools, scopeUnrestricted, type Scope } from '../manifest/scope.js';

export interface Args {
  /** Serialized code-defined routes, without credentials or server connection data. */
  toolDefinitions?: string;
  /** 明確指定的對外 tool id。 */
  tools?: string[];
  /** 開發用:不限制工具。必須明寫,不能靠「什麼都不給」達成。 */
  allTools?: boolean;
}

const FLAGS = ['--tools', '--all-tools', '--tool-definitions'] as const;

/**
 * 二選一,而且**必須擇一**。
 *
 * 不設預設值是刻意的:原本「沒給範圍 = 不限制」會讓一個打錯的旗標(`--agnet`)
 * 靜默變成開放全部工具 —— 失敗方向完全錯誤。現在未知旗標直接報錯,沒指定範圍
 * 也直接報錯,要全開得明寫 `--all-tools`。
 */
export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  const tools: string[] = [];
  let sawTools = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      // 旗標的值在下面消耗掉了,走到這裡的是多出來的:`--tools a b` 的 b。靜默略過的話,
      // 呼叫端以為開了 b,agent 卻沒有這個工具。
      throw new Error(`多餘的參數 ${a} —— --tools 的多個 id 用逗號連起來:--tools a,b`);
    }
    if (a === '--agent') {
      // 舊介面:hub 已經不讀 agent manifest。明講改法,不要只丟一句「未知參數」。
      throw new Error('--agent 已移除 —— 允許清單請由呼叫端算好,改用 --tools <id,id>');
    }
    if (!(FLAGS as readonly string[]).includes(a)) {
      throw new Error(`未知參數 ${a} —— 可用:${FLAGS.join(' / ')}`);
    }
    const v = argv[i + 1];
    const hasValue = v !== undefined && !v.startsWith('--');
    if (a === '--tool-definitions') {
      if (!hasValue) throw new Error('--tool-definitions requires a file path');
      out.toolDefinitions = v; i++;
    } else if (a === '--tools') {
      sawTools = true;
      if (hasValue) { tools.push(...v.split(',').map((s) => s.trim()).filter(Boolean)); i++; }
    } else {
      out.allTools = true;
    }
  }
  if (sawTools) out.tools = tools;

  const given = [out.tools && '--tools', out.allTools && '--all-tools'].filter(Boolean);
  if (given.length > 1) {
    // 訂優先序的話,「實際生效的是哪個」會變成要讀 code 才知道的事。
    throw new Error(`${given.join(' / ')} 只能擇一`);
  }
  if (given.length === 0) {
    throw new Error(`必須指定工具範圍:${FLAGS.join(' / ')}(全開請明寫 --all-tools)`);
  }
  return out;
}

export interface CheckArgs {
  /** 只撥這幾台;省略 = 全部。 */
  only?: string[];
  /** 印出上游實際的工具名(寫 mcp-servers/*.json 的 tools 表時照抄用)。 */
  listTools: boolean;
}

const CHECK_FLAGS = ['--server', '--list-tools'] as const;

/**
 * `check.ts` 的參數。放這裡跟 `parseArgs` 同理 —— entry 類的檔一被 import 就會跑,
 * 解析邏輯留在那裡就測不到。
 *
 * 跟 `parseArgs` 不同,這支**不要求**必須指定範圍:檢查全部是安全的預設,
 * 而 gateway 的「全開」不是。
 */
export function parseCheckArgs(argv: string[]): CheckArgs {
  const out: CheckArgs = { listTools: false };
  const only: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue; // 前一個旗標的值
    if (!(CHECK_FLAGS as readonly string[]).includes(a)) {
      throw new Error(`未知參數 ${a} —— 可用:${CHECK_FLAGS.join(' / ')}`);
    }
    if (a === '--list-tools') {
      out.listTools = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error('--server 需要至少一個 server id');
    only.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
  }

  if (only.length) out.only = only;
  return out;
}

/**
 * argv 的二選一 → `scope.ts` 的建構子。這裡只做分派,解析本身在 `scope.ts`
 * (`--tools` 那條跟 `openGateway({ tools })` 走的是同一個函式)。
 */
export function resolveScope(args: Args): Scope {
  const definitions = args.toolDefinitions ? JSON.parse(readFileSync(args.toolDefinitions, 'utf8')) : undefined;
  if (definitions !== undefined && !Array.isArray(definitions)) throw new Error('tool definitions must be an array');
  const catalog = loadCatalog(undefined, definitions);
  if (args.allTools) return scopeUnrestricted(catalog);
  return scopeForTools(args.tools!, catalog);
}
