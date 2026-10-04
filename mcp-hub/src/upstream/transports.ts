/**
 * ServerDecl → client transport。stdio / sse / streamable-http 三種外部上游;
 * in-memory 不在這裡,因為它還要順便把 builtin server 接起來(見 registry.ts)。
 *
 * **`${VAR}` 插值**:manifests 進 git,所以 token 一律用 `${JIRA_TOKEN}` 這種引用,
 * 實際值在連線時才從 process.env 取。故意**不在載入時解析** —— gitlab / figma 這些
 * 上游本來就是「有設 token 才啟用」(workflow 的 config 生成就是這樣寫的),載入時
 * 解析會讓一個沒設 token 的可選上游把整個 gateway 弄不起來。缺變數的代價因此縮到
 * 「連這台時才炸」,而且錯誤訊息直接指名是哪台的哪個變數。
 */
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FileOAuthProvider } from './oauth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ServerDecl } from '../manifest/load.js';

/** `${VAR}` — 只認這一種形式。裸 `$VAR` 不處理,避免誤傷含 `$` 的字面值。 */
/**
 * `${VAR}`:必填。`${VAR:-default}`:選用,沒設或空字串時代入 default(可以是空字串)。
 * 憑證一律用必填形式 —— 選用語法只給「不給也合法」的設定,例如功能開關、上限。
 */
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export type EnvSource = Record<string, string | undefined>;

/**
 * 展開一個字串裡的所有 `${VAR}` 與 `${VAR:-default}`。
 *
 * 必填的 `${VAR}` 缺值就 throw —— 空字串代換會讓 `--jira-token=` 這種參數靜默
 * 變成「沒有 token」,上游回 401 時很難查到根因。所以「可以不給」必須明寫成
 * `${VAR:-}`,不能靠預設行為。
 */
export function interpolate(
  value: string,
  where: string,
  env: EnvSource = process.env,
): string {
  return value.replace(REF, (_m, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v === undefined || v === '') {
      if (fallback !== undefined) return fallback;
      throw new Error(`${where}: 環境變數 ${name} 未設定(${value} 需要它)`);
    }
    return v;
  });
}

function interpolateArgs(args: string[] | undefined, where: string, env: EnvSource): string[] | undefined {
  return args?.map((a, i) => interpolate(a, `${where} args[${i}]`, env));
}

function interpolateEnv(
  vars: Record<string, string> | undefined,
  where: string,
  env: EnvSource,
): Record<string, string> | undefined {
  if (!vars) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = interpolate(v, `${where} env.${k}`, env);
  return out;
}

/**
 * 建一個外部上游的 client transport。欄位的必填性已在 manifest 載入時驗過
 * (validateServer),這裡只負責插值與建構 —— 但仍留 fallback throw,因為
 * `ServerDecl` 的型別上這些欄位是 optional。
 */
export function createExternalTransport(decl: ServerDecl, env: EnvSource = process.env): Transport {
  const where = `server "${decl.id}"`;

  if (decl.transport === 'stdio') {
    if (!decl.command) throw new Error(`${where}: stdio 缺 command`);
    return new StdioClientTransport({
      command: interpolate(decl.command, `${where} command`, env),
      ...(decl.args ? { args: interpolateArgs(decl.args, where, env)! } : {}),
      // env 傳進去是**取代**不是合併,直接給會讓子程序連 PATH 都沒有(npx / uvx 就找不到)。
      // 所以一律疊在 SDK 的安全白名單之上。
      env: { ...getDefaultEnvironment(), ...(interpolateEnv(decl.env, where, env) ?? {}) },
      // 上游的 stderr 併進 gateway 的 stderr。gateway 的 stdout 是 JSON-RPC,不能污染;
      // stderr 本來就是它寫 log 的地方,子程序的啟動錯誤也才看得到。
      stderr: 'inherit',
    });
  }

  if (!decl.url) throw new Error(`${where}: ${decl.transport} 缺 url`);
  const url = new URL(interpolate(decl.url, `${where} url`, env));

  // 不做 streamable-http ↔ sse 的自動 fallback:manifest 已經明寫是哪一種。
  // 猜錯 transport 應該是一個看得見的錯誤,不是一次悄悄的降級。
  // 有宣告 OAuth → 帶 gateway 模式的 provider:token 過期 SDK 自己 refresh;要重新授權就丟
  // OAuthLoginRequired(明講去跑 auth-login),不開瀏覽器、不裝作查無。
  const authProvider = decl.auth ? new FileOAuthProvider(decl.id, decl.auth, 'gateway', undefined, env as NodeJS.ProcessEnv) : undefined;
  return decl.transport === 'sse'
    ? new SSEClientTransport(url, authProvider ? { authProvider } : undefined)
    : new StreamableHTTPClientTransport(url, authProvider ? { authProvider } : undefined);
}
