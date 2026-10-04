/**
 * 跑一次子程序:串流、解碼、取消、逾時、清理。
 *
 * 這一層**不知道** agent、產物、事件編號是什麼 —— 它收一份組好的指令,吐
 * `RuntimeEvent` 與一個終態。engine 才把它包成 `RunEvent` 與 `TakeResult`。
 *
 * adapter 之所以能寫得很薄(只回「該執行什麼指令」),就是因為這裡的東西寫一次
 * 就好 —— 讓每個 adapter 自己 spawn 的話,process group kill 要重寫 N 次。
 */
import { spawn } from 'node:child_process';
import { trackGroup, untrackGroup } from './childGroups.js';
import { EngineError, type RuntimeDecoder, type RuntimeEvent, type SpawnCommand, type StopReason } from '../types.js';

/** SIGTERM 之後等多久才升級成 SIGKILL。 */
const DEFAULT_KILL_GRACE_MS = 3_000;
/** 送出 SIGKILL 之後,等多久還沒退出就認定「清理未確認」。 */
const DEFAULT_EXIT_GRACE_MS = 2_000;
/** stderr 只留尾巴,診斷夠用又不會把一個話很多的子程序變成記憶體問題。 */
const STDERR_KEEP = 4_096;

export interface ExecOpts {
  command: SpawnCommand;
  /** 省略 = 整段 stdout 當輸出,不解析事件。 */
  decoder?: RuntimeDecoder;
  signal?: AbortSignal;
  /** 整段執行的 wall-clock 上限。省略 = 無上限。 */
  timeoutMs?: number;
  /**
   * 解碼後文字的上限(位元組)。超過就砍斷子程序,終態 `max_output`。
   * 省略 = 無上限 —— 但那代表一個跑偏的 agent 可以把記憶體吃光。
   */
  maxOutputBytes?: number;
  /** 每個事件都會等它完成才繼續讀,所以落盤順序與到達順序一致。 */
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  killGraceMs?: number;
  exitGraceMs?: number;
}

export interface ExecResult {
  /** 解碼後的文字。沒有 decoder 時就是整段 stdout。**不是原始 JSONL。** */
  text: string;
  stopReason: StopReason;
  /**
   * `unconfirmed` = 送了 SIGKILL 之後在期限內沒看到子程序退出。
   * 不宣稱資源已停止 —— 說謊比承認不確定糟。
   */
  cleanup: 'complete' | 'unconfirmed';
  exitCode: number | null;
  /** 尾端 stderr,給診斷用。 */
  stderr: string;
}

/**
 * 殺掉整個 process group 而不是單一 pid。
 *
 * `claude -p` 會再 spawn MCP server,e2e 那條是 bash 再 spawn claude ——
 * 只 kill 直接子程序會留下孫程序繼續跑(而且還握著管線)。POSIX 上要
 * `detached: true` 讓子程序自成一個 group,才能用負號 pid 打整組。
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // ESRCH = 已經不在了,那正是我們要的結果。
  }
}

/** group 裡還有沒有活著的程序(signal 0 只檢查不送)。Windows 沒有 group,當作沒有。 */
function groupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGroupGone(pid: number, until: number): Promise<boolean> {
  while (groupAlive(pid)) {
    if (Date.now() >= until) return false;
    await sleep(50);
  }
  return true;
}

/**
 * 結算前把 group 收乾淨:子程序退出不代表孫程序也退了(沒握管線的孫程序不會擋住 'close')。
 * 還有殘留就(若還沒送過)先 SIGTERM,等寬限期到 `termDeadline`,再 SIGKILL 等 `exitGrace`。
 * 回傳 group 是否確認已空 —— 不確定就不能報 complete。
 */
async function reapGroup(pid: number, o: { termSent: boolean; termDeadline: number; exitGrace: number }): Promise<boolean> {
  if (!groupAlive(pid)) return true;
  if (!o.termSent) killGroup(pid, 'SIGTERM');
  if (await waitGroupGone(pid, o.termDeadline)) return true;
  killGroup(pid, 'SIGKILL');
  return waitGroupGone(pid, Date.now() + o.exitGrace);
}

/** process.env 疊上 command.env;值為 `undefined` 的鍵從結果拿掉(見 `SpawnCommand.env`)。 */
export function childEnv(overlay: SpawnCommand['env']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overlay ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export function execRuntime(o: ExecOpts): Promise<ExecResult> {
  const killGrace = o.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const exitGrace = o.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;

  return new Promise<ExecResult>((resolve, reject) => {
    if (o.signal?.aborted) {
      resolve({ text: '', stopReason: 'cancelled', cleanup: 'complete', exitCode: null, stderr: '' });
      return;
    }

    // cwd 由 engine 預設成 root(見 engine.ts);省略時才繼承呼叫端的工作目錄。
    const child = spawn(o.command.file, o.command.args, {
      ...(o.command.cwd ? { cwd: o.command.cwd } : {}),
      // stdin 一律 pipe:沒有內容時立刻 end(),子程序讀到的就是 EOF,跟 'ignore' 一樣不會卡住等輸入。
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv(o.command.env),
      // 自成一個 process group,才殺得掉孫程序(見 killGroup)。
      detached: process.platform !== 'win32',
    });
    // detached 的代價:宿主死了 group 不會跟著死。登記起來,宿主結束時一起收(見 childGroups)。
    if (child.pid !== undefined) trackGroup(child.pid);
    // 子程序沒讀完就退出(或根本起不來)時寫入會 EPIPE。那不是這次執行的錯誤來源 ——
    // 真正的原因會從退出碼 / stderr / 'error' 事件出來,這裡吞掉就好,不然會變成未捕捉的例外。
    child.stdin.on('error', () => {});
    child.stdin.end(o.command.stdin ?? '', 'utf8');

    let text = '';
    /** `text` 的 UTF-8 位元組數,跟著累加 —— 每個 chunk 都重算整段會隨輸出變長而變成平方成本。 */
    let textBytes = 0;
    let stderr = '';
    let stopped: StopReason | undefined;   // decoder 明講的終止原因
    let cancelled = false;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    /**
     * onEvent 丟出的第一個錯誤(通常是落盤失敗)。不當場 reject —— 子程序還活著,
     * 要先殺掉整個 group、等它退出,才回報失敗;否則 claude 與它的工具會在背景繼續跑。
     */
    let eventError: unknown;
    /** 事件依序處理:落盤順序要跟到達順序一致,不能並行。 */
    let queue: Promise<void> = Promise.resolve();

    const emit = (events: RuntimeEvent[]): void => {
      for (const e of events) {
        // 文字在這裡累積,順便讓 'output' 有機會取代累積值(它是最終全文)。
        if (e.type === 'text') { text += e.chunk; textBytes += Buffer.byteLength(e.chunk, 'utf8'); }
        else if (e.type === 'output') { text = e.text; textBytes = Buffer.byteLength(text, 'utf8'); }
        else if (e.type === 'stopped') stopped = e.reason;
        // 已經失敗就不再送:宿主的 sink 壞了,繼續寫只會多出更多錯誤。
        if (o.onEvent) queue = queue.then(() => { if (eventError === undefined) return o.onEvent!(e); });
      }
      queue = queue.catch((err) => {
        if (eventError !== undefined) return;
        eventError = err ?? new EngineError('runtime', 'onEvent failed');
        terminate();
      });

      // 超量就砍掉,不要繼續收 —— 目的是保住記憶體,所以要在累積之後立刻判。
      // 已經收到的文字留著:它跟逾時一樣可能救得回來。
      if (!overflowed && o.maxOutputBytes !== undefined && textBytes > o.maxOutputBytes) {
        overflowed = true;
        terminate();
      }
    };

    // `cleanup` 把 reapGroup 算出的收尾結果帶到 reject 上 —— 沒帶的話 engine 的
    // catch 無從得知子程序組是否確認收乾淨,只能預設 'complete',把一個其實
    // 'unconfirmed' 的失敗標成乾淨。預設 'unconfirmed':走到 fail 代表子程序已
    // spawn 且出事,寧可保守。
    const fail = (error: unknown, cleanup: ExecResult['cleanup'] = 'unconfirmed'): void => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      const err = error instanceof Error ? error : new EngineError('runtime', String(error));
      (err as { cleanup?: ExecResult['cleanup'] }).cleanup = cleanup;
      reject(err);
    };

    const settle = (result: ExecResult): void => {
      // onEvent 失敗時 result 仍帶著 finish()/reapGroup 算出的真實收尾結果 —— 轉交 fail。
      if (eventError !== undefined) return fail(eventError, result.cleanup);
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve(result);
    };

    // ── 收尾:先 SIGTERM 給機會善終,逾期升級 SIGKILL ──────────────────────
    let killTimer: NodeJS.Timeout | undefined;
    let exitGuard: NodeJS.Timeout | undefined;
    /** 送出 SIGTERM 的時間;結算時用它算孫程序還剩多少寬限期。 */
    let termSentAt: number | undefined;
    const terminate = (): void => {
      if (child.pid === undefined || killTimer !== undefined) return;
      termSentAt = Date.now();
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
      }, killGrace);
      killTimer.unref?.();

      // 清理期限。殺了之後子程序還是不退(孫程序卡在不可中斷的系統呼叫之類),
      // 就誠實回報「未確認」—— 宿主要知道可能有東西還活著。說謊比承認不確定糟。
      exitGuard = setTimeout(() => {
        settle({
          text,
          stopReason: cancelled ? 'cancelled' : overflowed ? 'max_output' : 'timeout',
          cleanup: 'unconfirmed',
          exitCode: null,
          stderr,
        });
      }, killGrace + exitGrace);
      exitGuard.unref?.();
    };

    const onAbort = (): void => { cancelled = true; terminate(); };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (o.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, o.timeoutMs);
    }

    let closeGuard: NodeJS.Timeout | undefined;
    function cleanupListeners(): void {
      // 確認整組都不在了才除名;unconfirmed 的留著,宿主結束時再補殺一次。
      if (child.pid !== undefined && !groupAlive(child.pid)) untrackGroup(child.pid);
      o.signal?.removeEventListener('abort', onAbort);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (exitGuard) clearTimeout(exitGuard);
      if (closeGuard) clearTimeout(closeGuard);
    }

    // 用 setEncoding 而不是逐 chunk toString():一個 UTF-8 字元可能被拆在兩個 chunk,
    // 各自解碼會變成 �(中文報告就這樣壞掉,而且終態照樣是成功)。setEncoding 內部用
    // StringDecoder,會把不完整的位元組留到下一個 chunk 再解。
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (o.decoder) emit(o.decoder.push(chunk));
      else emit([{ type: 'text', chunk }]);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });

    child.on('error', (e) => fail(new EngineError('runtime', `無法執行 ${o.command.file}: ${e.message}`, e)));

    // 'exit' 只代表子程序退出,管線裡可能還有沒讀完的資料 —— 要等 'close'(stdio 都排空)才結算,
    // 否則報告會缺尾段。孫程序繼承了 stdout 的話,'close' 要等它們也關掉管線才會來。
    let exitCode: number | null = null;
    let finishing = false;
    const finish = (cleanup: ExecResult['cleanup']): void => {
      if (settled || finishing) return;
      finishing = true;

      // decoder 的尾巴要排空 —— JSONL 最後一行可能還在緩衝區裡。
      if (o.decoder) {
        try { emit(o.decoder.finish()); } catch (e) { return fail(e); }
      }

      void queue.then(async () => {
        // 子程序退了、管線關了,group 裡仍可能有忽略 SIGTERM 又沒握管線的孫程序。
        // 確認整組停止才算 complete;收不乾淨就 unconfirmed(settle 會清掉 SIGKILL 計時器,
        // 所以這裡要自己升級,不能指望那個計時器)。
        let finalCleanup = cleanup;
        if (child.pid !== undefined) {
          const clean = await reapGroup(child.pid, {
            termSent: termSentAt !== undefined,
            termDeadline: (termSentAt ?? Date.now()) + killGrace,
            exitGrace,
          });
          if (!clean) finalCleanup = 'unconfirmed';
        }
        settle({
          text,
          // 取消與逾時是**我們**造成的,優先於子程序自己回報的任何原因 ——
          // 被 SIGKILL 的程序常常回一個沒意義的退出碼。
          stopReason: cancelled ? 'cancelled'
            : timedOut ? 'timeout'
            : overflowed ? 'max_output'
            : stopped ?? (exitCode === 0 ? 'end_turn' : 'unknown'),
          cleanup: finalCleanup,
          exitCode,
          stderr,
        });
      }, fail);
    };

    child.on('exit', (code) => {
      exitCode = code;
      // 子程序已退出;接下來由 closeGuard 等管線排空,不再需要「殺了還不退」的期限。
      if (exitGuard) clearTimeout(exitGuard);
      // 孫程序一直握著管線的話 'close' 永遠不來:期限到就殺掉殘留的 group、自己關管線,
      // 並回報「未確認」—— 殘留的是不是真的停了，我們沒看到。
      closeGuard = setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish('unconfirmed');
      }, exitGrace);
      closeGuard.unref?.();
    });

    // 走到 'close' 就表示子程序退出、管線也全關了。
    child.on('close', () => finish('complete'));

  });
}
