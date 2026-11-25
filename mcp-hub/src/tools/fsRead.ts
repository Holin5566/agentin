/**
 * 唯讀檔案工具(`fs_read_file` / `fs_list_dir` / `fs_glob` / `fs_grep`)。
 *
 * **給沒有原生檔案工具的 runtime 用**:claude 自帶 Read / Grep / Glob,裸模型(地端 bifrost 等)沒有,
 * 所以「這個 agent 要唯讀檔案」要靠 gateway 提供的工具來表達。
 *
 * 套件預設**不帶任何工具**(`BUILTIN_TOOLS` 永遠是空的)—— 這裡只是**工廠**,由宿主決定要不要掛:
 * 跑 `dist/bin/fsServer.js`,再在 `manifests/mcp-servers/` 宣告成一台 stdio server。
 *
 * ## 沙箱(這是權限邊界,失敗方向只能往嚴)
 *
 * - 所有路徑必須落在 `roots` 之內。**比對的是 realpath**,所以 `..` 與指向 roots 外的 symlink 都擋得住。
 * - 走訪(glob / grep / list)**不跟 symlink**:避免繞出 roots 或進入迴圈。明確指定的單一檔案才會解 symlink
 *   (而且解開後仍要在 roots 內)。
 * - 預設拒絕敏感與雜訊路徑:`.git`、`node_modules`、`.agent-engine`,以及 `.env*` / `*.env` / `secrets*` /
 *   `credentials*` / 私鑰 / 資料庫檔(`*.sqlite` `*.db` `.pgpass`)類檔名。走訪時**直接略過**
 *   (不會出現在結果裡),明確讀取則回「存取被拒」。
 * - **`allowTop`(強烈建議設)**:只開放專案根底下指定的頂層目錄(例 `['repos', 'domain']`)。denylist 永遠列不完
 *   (記錄檔、暫存、備份、別的功能的資料夾…),允許清單才是「預設拒絕」。根目錄直接底下的檔案一律不開放。
 * - 二進位檔不讀;單檔過大不讀;輸出有上限 —— 一次呼叫不能把模型的 context 灌爆。
 * - `fs_grep` 的 regex 是模型給的,可能寫出會災難性回溯的 pattern(`(a+)+$`)。逐行比對放在 `vm` 裡跑,
 *   **每個檔案有逾時**(`grepTimeoutMs`),逾時回 `ToolFailure` 請模型改寫 —— 不卡住整個呼叫,
 *   也不偽裝成「沒有符合」。
 * - 沒有任何寫入能力。
 *
 * 錯誤訊息要**可執行**:不只說「被拒」,還說下一步該怎麼做(回報、別猜路徑)。模型被擋下後若沒有指引,
 * 會亂試路徑直到 token 用完(實測 Qwen)。
 *
 * ## 三態(見 `types.ts`)
 * 查無結果 → 正常回傳「(無)」;路徑不合法 / 被拒 / 讀不了 → `ToolFailure`;取消 → `AbortError` 往上。
 * 別把「被沙箱擋住」壓成「沒有符合的檔案」:模型會把它讀成「這段 code 不存在」。
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ToolFailure } from '../types.js';
import type { BuiltinTool } from '../types.js';

export interface FsReadOptions {
  /** 允許讀取的根目錄(至少一個)。相對路徑以第一個 root 為基準。 */
  roots: string[];
  /** 額外拒絕的檔名 / 目錄名 glob(疊在預設之上)。 */
  deny?: string[];
  /** 只開放 root 底下這些頂層目錄(名稱完全相等,區分大小寫)。省略 = 整個 root(除了 denylist)。 */
  allowTop?: string[];
  /** 單檔大小上限(位元組)。預設 5MB。 */
  maxFileBytes?: number;
  /** `fs_read_file` 預設行數。預設 2000。 */
  defaultReadLines?: number;
  /** 單次輸出字元上限。預設 100_000。 */
  maxOutputChars?: number;
  /** glob / grep 結果筆數上限。預設 200。 */
  maxResults?: number;
  /** `fs_grep` 單一檔案的 regex 比對上限(毫秒)。預設 2000。 */
  grepTimeoutMs?: number;
}

const DENY_DIRS = new Set(['.git', 'node_modules', '.agent-engine']);
/** 檔名層級的預設拒絕(不分大小寫)。 */
const DENY_FILE_PATTERNS = [
  '.env', '.env.*', '*.env', 'secrets', 'secrets.*', '*.secrets', 'credentials', 'credentials.*',
  '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_rsa.*', 'id_ed25519', 'id_ed25519.*', '.npmrc', '.netrc',
  '*.sqlite', '*.sqlite3', '*.db', '.pgpass',
];

const MAX_LINE_CHARS = 2000;
const MAX_GREP_LINE_CHARS = 300;
const MAX_WALK_FILES = 50_000;

/** glob → RegExp。支援 `**` `*` `?` `{a,b}` `[...]`;其餘字元一律跳脫。 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` = 零層或多層目錄;結尾的 `**` = 任何東西
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { out += '\\{'; continue; }
      out += `(?:${glob.slice(i + 1, end).split(',').map((p) => globToRegExp(p).source.slice(1, -1)).join('|')})`;
      i = end;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) { out += '\\['; continue; }
      out += glob.slice(i, end + 1);
      i = end;
    } else out += c.replace(/[.+^$()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function createFsReadTools(opts: FsReadOptions): BuiltinTool<string>[] {
  if (opts.roots.length === 0) throw new Error('fs tools: roots 不能是空的');
  const roots = opts.roots.map((r) => {
    try { return realpathSync(resolve(r)); } catch { throw new Error(`fs tools: root 不存在或讀不了:${r}`); }
  });
  const maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024;
  const defaultReadLines = opts.defaultReadLines ?? 2000;
  const maxOutputChars = opts.maxOutputChars ?? 100_000;
  const maxResults = opts.maxResults ?? 200;
  const grepTimeoutMs = opts.grepTimeoutMs ?? 2000;
  const denyNames = [...DENY_FILE_PATTERNS, ...(opts.deny ?? [])].map((p) => globToRegExp(p.toLowerCase()));

  const isDeniedName = (name: string, isDir: boolean): boolean =>
    isDir ? DENY_DIRS.has(name) : denyNames.some((re) => re.test(name.toLowerCase()));

  const allowTop = opts.allowTop ? new Set(opts.allowTop) : undefined;

  /** 不在頂層允許清單內(root 本身不算:列根目錄要能看到被允許的那幾個)。 */
  const outsideAllowTop = (abs: string): boolean => {
    if (!allowTop) return false;
    const root = roots.find((r) => abs === r || abs.startsWith(r + sep));
    if (!root) return true;
    const top = relative(root, abs).split(sep).filter(Boolean)[0];
    return top !== undefined && !allowTop.has(top);
  };

  /** 相對於其所屬 root 的路徑,任何一段被拒就算被拒(含不在頂層允許清單)。 */
  const isDeniedPath = (abs: string, isDir: boolean): boolean => {
    const root = roots.find((r) => abs === r || abs.startsWith(r + sep));
    if (!root) return true;
    if (outsideAllowTop(abs)) return true;
    const segs = relative(root, abs).split(sep).filter(Boolean);
    return segs.some((s, i) => isDeniedName(s, i < segs.length - 1 || isDir));
  };

  /** 把模型給的路徑解成 root 內的真實絕對路徑;出界 / 不存在 / 被拒都 throw。 */
  function resolveSafe(p: unknown, fallbackToRoot = false): { abs: string; isDir: boolean } {
    const raw = typeof p === 'string' && p.trim() ? p.trim() : fallbackToRoot ? '.' : undefined;
    if (raw === undefined) throw new ToolFailure('缺少參數 path');
    const candidate = isAbsolute(raw) ? raw : resolve(roots[0], raw);
    let real: string;
    try { real = realpathSync(candidate); } catch { throw new ToolFailure(`路徑不存在:${raw}。可用 fs_list_dir 看上一層確認名稱;確認沒有就直接回報「找不到」,不要猜其他路徑`); }
    if (!roots.some((r) => real === r || real.startsWith(r + sep))) {
      throw new ToolFailure(`存取被拒:${raw} 在允許範圍之外。請只用專案內的相對路徑;讀不到就直接回報「無權限讀取」,不要嘗試繞過`);
    }
    const isDir = statSync(real).isDirectory();
    // 這幾則拒絕訊息都附「下一步」(回報 / 別猜 / 別繞過),不只說被拒:實測 Qwen 被擋下後沒有指引,
    // 會亂試 `repos/x`、`domain/x`… 直到 token 用完(同一個題目 3 次都空轉到 max_tokens、約 60 秒);
    // 加上指引後,3 次裡有 2 次在 9–12 秒內直接答「找不到」(小樣本)。
    if (outsideAllowTop(real)) throw new ToolFailure(`存取被拒:${raw} 不在開放的目錄內(只開放:${[...allowTop!].join('、')})。不要猜其他路徑;要找的東西不在這些目錄裡,就直接回報「找不到 / 無權限讀取」`);
    if (isDeniedPath(real, isDir)) throw new ToolFailure(`存取被拒:${raw} 是受保護的路徑(金鑰 / .git / node_modules 等)。不要嘗試繞過,直接回報「無權限讀取」`);
    return { abs: real, isDir };
  }

  const rel = (abs: string): string => {
    const root = roots.find((r) => abs === r || abs.startsWith(r + sep)) ?? roots[0];
    return relative(root, abs) || '.';
  };

  function looksBinary(buf: Buffer): boolean {
    return buf.subarray(0, 8192).includes(0);
  }

  function readText(abs: string): string {
    const size = statSync(abs).size;
    if (size > maxFileBytes) throw new ToolFailure(`檔案太大(${size} 位元組,上限 ${maxFileBytes}):請用 fs_grep 找位置,或指定 offset / limit 分段讀`);
    const buf = readFileSync(abs);
    if (looksBinary(buf)) throw new ToolFailure(`二進位檔案,不讀:${rel(abs)}`);
    return buf.toString('utf8');
  }

  /** 走訪 dir 下的檔案(不跟 symlink、略過被拒的、有上限)。 */
  function* walk(dir: string, signal: AbortSignal, budget = { files: 0 }): Generator<string> {
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (isDeniedPath(join(dir, e.name), true)) continue;
        yield* walk(join(dir, e.name), signal, budget);
      } else if (e.isFile()) {
        if (isDeniedPath(join(dir, e.name), false)) continue;
        if (++budget.files > MAX_WALK_FILES) throw new ToolFailure(`目錄太大(超過 ${MAX_WALK_FILES} 個檔案):請縮小 path`);
        yield join(dir, e.name);
      }
    }
  }

  /**
   * 在 `lines` 裡找符合的行號(最多 `limit` 個),**有逾時**。
   * regex 在主執行緒同步跑,病態 pattern 會一直占著;`vm` 的 timeout 能中斷它(Node 20 實測)。
   * context 只建一次、重複使用 —— 每個檔案各建一次太貴(幾萬個檔案時以秒計)。
   */
  const matchCtx = createContext({ re: undefined as unknown as RegExp, lines: [] as string[], limit: 0 });
  const matchScript = new Script(
    '(function () { const out = []; for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { out.push(i); if (out.length >= limit) break; } } return out; })()',
  );
  function matchingLines(re: RegExp, lines: string[], limit: number, shown: string): number[] {
    Object.assign(matchCtx, { re, lines, limit });
    try {
      return matchScript.runInContext(matchCtx, { timeout: grepTimeoutMs }) as number[];
    } catch (e: any) {
      if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new ToolFailure(`正規表示式比對逾時(單一檔案超過 ${grepTimeoutMs}ms,檔案 ${shown}):pattern 可能會災難性回溯` +
          `(例如巢狀量詞 (a+)+)。請改寫成不巢狀、更精確的 pattern,或用 glob / path 縮小範圍`);
      }
      throw e;
    } finally {
      Object.assign(matchCtx, { re: undefined, lines: [], limit: 0 }); // 不留著上一個檔案的內容
    }
  }

  const clip = (text: string): string =>
    text.length <= maxOutputChars ? text : `${text.slice(0, maxOutputChars)}\n…[輸出已截斷:原長 ${text.length} 字元,只保留前 ${maxOutputChars}]`;

  /** 路徑 glob:含 `/` 比對相對路徑;不含 `/` 比對任何層級的檔名。 */
  const matcherFor = (glob: string): ((relPath: string) => boolean) => {
    const re = globToRegExp(glob);
    return glob.includes('/') ? (p) => re.test(p) : (p) => re.test(basename(p));
  };

  const num = (v: unknown, dflt: number, min: number, max: number): number => {
    if (v === undefined || v === null) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ToolFailure('數字參數不合法');
    return Math.min(max, Math.max(min, Math.floor(n)));
  };

  return [
    {
      name: 'fs_read_file',
      description: '讀一個文字檔,每行前面帶行號。大檔用 offset(從第幾行起,1 起算)/ limit(讀幾行)分段。路徑相對於專案根。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '檔案路徑(相對專案根或絕對路徑,必須在允許範圍內)' },
          offset: { type: 'number', description: '從第幾行開始(1 起算),預設 1' },
          limit: { type: 'number', description: `最多讀幾行,預設 ${defaultReadLines}` },
        },
        required: ['path'],
      },
      async execute(args) {
        const { abs, isDir } = resolveSafe(args.path);
        if (isDir) throw new ToolFailure(`這是目錄不是檔案:${rel(abs)}(請用 fs_list_dir)`);
        const lines = readText(abs).split('\n');
        if (lines.at(-1) === '') lines.pop();
        const offset = num(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
        const limit = num(args.limit, defaultReadLines, 1, defaultReadLines);
        if (lines.length === 0) return `(空檔案:${rel(abs)})`;
        if (offset > lines.length) throw new ToolFailure(`offset ${offset} 超過檔案行數(共 ${lines.length} 行)`);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const body = slice
          .map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…[行已截斷]` : l}`)
          .join('\n');
        const last = offset + slice.length - 1;
        const note = last < lines.length ? `\n…[顯示第 ${offset}–${last} 行,共 ${lines.length} 行;用 offset=${last + 1} 繼續]` : '';
        return clip(body + note);
      },
    },
    {
      name: 'fs_list_dir',
      description: '列出一個目錄的內容(目錄名尾端帶 /)。不含被保護的路徑。省略 path = 專案根。',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: '目錄路徑,省略 = 專案根' } } },
      async execute(args) {
        const { abs, isDir } = resolveSafe(args.path, true);
        if (!isDir) throw new ToolFailure(`這是檔案不是目錄:${rel(abs)}`);
        const names = readdirSync(abs, { withFileTypes: true })
          .filter((e) => !e.isSymbolicLink() && (e.isDirectory() || e.isFile()) && !isDeniedPath(join(abs, e.name), e.isDirectory()))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        if (names.length === 0) return '(空目錄)';
        const shown = names.slice(0, maxResults);
        return shown.join('\n') + (names.length > shown.length ? `\n…[共 ${names.length} 項,只列前 ${shown.length}]` : '');
      },
    },
    {
      name: 'fs_glob',
      description: '用 glob 找檔案。支援 ** * ? {a,b}。pattern 不含 / 時比對任何層級的檔名(例 "*.ts");含 / 時比對相對路徑(例 "src/**/*.ts")。',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 樣式' },
          path: { type: 'string', description: '從哪個目錄找,省略 = 專案根' },
        },
        required: ['pattern'],
      },
      async execute(args, signal) {
        if (typeof args.pattern !== 'string' || !args.pattern) throw new ToolFailure('缺少參數 pattern');
        const { abs, isDir } = resolveSafe(args.path, true);
        if (!isDir) throw new ToolFailure(`path 必須是目錄:${rel(abs)}`);
        const match = matcherFor(args.pattern);
        const hits: string[] = [];
        let total = 0;
        for (const f of walk(abs, signal)) {
          if (!match(relative(abs, f))) continue;
          total++;
          if (hits.length < maxResults) hits.push(rel(f));
        }
        if (total === 0) return '(沒有符合的檔案)';
        return hits.join('\n') + (total > hits.length ? `\n…[共 ${total} 個,只列前 ${hits.length}]` : '');
      },
    },
    {
      name: 'fs_grep',
      description: '在檔案內容中搜尋正規表示式,回傳「路徑:行號:內容」。可用 glob 限縮檔案、path 限縮目錄。二進位檔與被保護的路徑會略過。',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript 正規表示式' },
          path: { type: 'string', description: '目錄或單一檔案,省略 = 專案根' },
          glob: { type: 'string', description: '只搜符合的檔案,例 "*.ts" 或 "src/**/*.cs"' },
          ignoreCase: { type: 'boolean', description: '忽略大小寫,預設 false' },
          maxResults: { type: 'number', description: `最多回幾筆,預設 ${maxResults}` },
        },
        required: ['pattern'],
      },
      async execute(args, signal) {
        if (typeof args.pattern !== 'string' || !args.pattern) throw new ToolFailure('缺少參數 pattern');
        let re: RegExp;
        try { re = new RegExp(args.pattern, args.ignoreCase === true ? 'i' : ''); }
        catch (e: any) { throw new ToolFailure(`正規表示式不合法:${e?.message ?? e}`); }
        const { abs, isDir } = resolveSafe(args.path, true);
        const limit = num(args.maxResults, maxResults, 1, maxResults);
        const match = typeof args.glob === 'string' && args.glob ? matcherFor(args.glob) : () => true;
        const files = isDir ? walk(abs, signal) : [abs];
        const out: string[] = [];
        let truncated = false;
        outer: for (const f of files) {
          if (isDir && !match(relative(abs, f))) continue;
          let text: string;
          try {
            if (statSync(f).size > maxFileBytes) continue;
            const buf = readFileSync(f);
            if (looksBinary(buf)) continue;
            text = buf.toString('utf8');
          } catch { continue; }
          const lines = text.split('\n');
          // 多要一筆:剛好滿額時分得出「正好 limit 筆」與「還有更多」。
          for (const i of matchingLines(re, lines, limit - out.length + 1, rel(f))) {
            if (out.length >= limit) { truncated = true; break outer; }
            const l = lines[i];
            out.push(`${rel(f)}:${i + 1}:${l.length > MAX_GREP_LINE_CHARS ? `${l.slice(0, MAX_GREP_LINE_CHARS)}…` : l}`);
          }
        }
        if (out.length === 0) return '(沒有符合的內容)';
        return clip(out.join('\n') + (truncated ? `\n…[已達 ${limit} 筆上限,可縮小 path / glob 或換更精確的 pattern]` : ''));
      },
    },
  ];
}
