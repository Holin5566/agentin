/**
 * 宿主程序死掉時,把還在跑的 runtime process group 一起帶走。
 *
 * exec 讓每個子程序自成一個 group(`detached`),才殺得掉孫程序 —— 代價是宿主死了它們不會
 * 跟著死。bot 被 pm2 重啟(SIGINT)時,`claude -p` 與它的 MCP server 會變成孤兒繼續跑。
 *
 * 這裡記下所有還沒確認收乾淨的 group,並在兩個時機殺掉:
 * - `exit`:宿主正常結束或自己呼叫 `process.exit()`。exit handler 只能做同步的事,所以直接 SIGKILL。
 * - SIGINT / SIGTERM / SIGHUP,**且沒有別人接這個訊號時**:宿主靠的是預設行為(直接結束),
 *   不會跑 `exit` handler。先殺 group,再拿掉自己、把訊號重送給自己,結束方式跟沒掛 hook 時一樣。
 *   宿主有自己的 handler 時(例如終端機 CLI 用 Ctrl+C 取消目前回覆)就什麼都不做 —— 那個訊號
 *   不代表要結束,收尾是宿主的事:呼叫 `engine.close()` 或 `killAllRuntimeGroups()`。
 *
 * 被 SIGKILL 的宿主沒有任何 hook 能跑,那種情況只能靠外部(pm2 的 kill_timeout 夠長,讓 SIGINT 先生效)。
 */

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const live = new Set<number>();
let installed = false;

/** 殺掉所有還登記著的 group,回傳送了幾個。 */
export function killAllRuntimeGroups(signal: NodeJS.Signals = 'SIGKILL'): number {
  let n = 0;
  for (const pid of live) {
    try { process.kill(-pid, signal); n++; } catch { /* ESRCH:已經不在了 */ }
  }
  live.clear();
  return n;
}

export function trackGroup(pid: number): void {
  if (process.platform === 'win32') return; // 沒有 process group
  live.add(pid);
  install();
}

export function untrackGroup(pid: number): void {
  live.delete(pid);
}

/** 目前登記著的 group 數,給測試用。 */
export function trackedGroupCount(): number {
  return live.size;
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on('exit', () => { killAllRuntimeGroups(); });
  for (const sig of SIGNALS) {
    const onSignal = (): void => {
      if (process.listenerCount(sig) > 1) return; // 宿主自己接了,交給它
      killAllRuntimeGroups();
      process.removeListener(sig, onSignal);
      process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
}
