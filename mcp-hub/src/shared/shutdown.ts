/**
 * stdio server 的收尾:gateway(`bin/entry.ts`)與宿主工具 server(`builtin/stdio.ts`)共用。
 *
 * 三個觸發點:SIGINT / SIGTERM,以及 stdin EOF —— 呼叫端被 SIGKILL 或崩潰時沒有訊號,只剩
 * 管線斷掉;SDK 的 StdioServerTransport 對 EOF 無感(只掛 'data' / 'error'),不自己收就會留下
 * 孤兒程序。`close` 卡住時(某個上游關不掉)寬限期到就直接走:寧可漏關一條連線,也不要留一個
 * 永遠不退的程序。
 */

/** 收尾的硬上限。 */
export const SHUTDOWN_GRACE_MS = 3000;

/** 裝好收尾;回傳可以主動呼叫的 shutdown。重複觸發(EOF 與 SIGTERM 可能都來)只跑一次。 */
export function installShutdown(label: string, close: () => Promise<unknown>): (reason: string) => Promise<void> {
  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[${label}] shutting down — ${reason}\n`);
    // unref:計時器本身不撐住 event loop。
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin EOF'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
  return shutdown;
}
