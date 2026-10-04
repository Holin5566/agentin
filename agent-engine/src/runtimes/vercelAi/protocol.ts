/**
 * runner 印到 stdout 的 JSONL 協定 —— **寫的一邊(`runner.ts`)與讀的一邊(`decoder.ts`)共用這一份定義**,
 * 不各寫各的,免得格式悄悄分岔。
 *
 * 一行一個事件。decoder 對不認得的行(例如 SDK 偶爾印到 stdout 的警告)一律略過,所以這裡只定義我們發的。
 */
import { EngineError } from '../../types.js';
import type { StopReason } from '../../types.js';

export type RunnerLine =
  | { t: 'text'; chunk: string }
  | { t: 'tool-start'; id: string; name: string; input?: unknown }
  | { t: 'tool-end'; id: string; ok: boolean; elapsedMs: number; output?: string }
  /** 收尾。`output` 是最後一輪的全文(中間 tool 輪的文字不算)。沒看到 `done` = 異常中斷。 */
  | { t: 'done'; reason: StopReason; output: string; usage?: { inputTokens?: number; outputTokens?: number } };

export const encodeLine = (line: RunnerLine): string => JSON.stringify(line) + '\n';

// ─── 失敗標記(stderr 最後一行)────────────────────────────────────────────────────────────
//
// runner 失敗時沒有 `done` 行,engine 只看得到退出碼與 stderr 尾端(engine 把尾端併進 `EngineError.message`)。
// 宿主要決定「重試有沒有用」,不該去猜自由格式的錯誤訊息 —— 所以 runner 在 stderr **最後一行**印一個有定義格式的標記。
// 標記是 runner 與 runtime 之間的傳輸細節:`createVercelAiCli` 的 `classifyFailure` 用 `parseRunnerFailure(stderr)` 讀它,
// engine 把結果放進 `EngineError.retryable` / `.status`;**宿主只讀那兩個欄位**,不碰標記、不碰訊息。
// engine 保留 stderr 的**尾端**,最後一行不會被截掉。

export interface RunnerFailure {
  /** 模型端回的 HTTP 狀態碼(有的話)。 */
  status?: number;
  /** 同樣的請求再送一次有沒有可能成功。 */
  retryable: boolean;
}

export const FAILURE_MARKER = '@@runner-failure ';

/**
 * 重試政策(唯一一處):模型端回「你的請求有問題」(400 / 401 / 403 / 404 / 422 —— 金鑰無效、模型不存在…)重試不會有用;
 * 429(限流)、408、5xx 與連線失敗仍然值得重試。
 */
export const isRetryableHttp = (status: number | undefined): boolean =>
  status === undefined || ![400, 401, 403, 404, 422].includes(status);

export const encodeFailure = (f: RunnerFailure): string => `${FAILURE_MARKER}${JSON.stringify(f)}\n`;

/** 從 `EngineError.message`(含 stderr 尾端)找最後一個失敗標記。沒有(不是 runner 的失敗、或格式壞了)= undefined。 */
export function parseRunnerFailure(text: string): RunnerFailure | undefined {
  const i = text.lastIndexOf(FAILURE_MARKER);
  if (i < 0) return undefined;
  const line = text.slice(i + FAILURE_MARKER.length).split('\n', 1)[0];
  try {
    const f = JSON.parse(line) as Partial<RunnerFailure>;
    if (typeof f.retryable !== 'boolean') return undefined;
    return { retryable: f.retryable, ...(typeof f.status === 'number' ? { status: f.status } : {}) };
  } catch { return undefined; }
}

/** 失敗 → 宿主讀得懂的分類(見 `protocol.ts` 的失敗標記)。 */
export function classifyFailure(e: unknown): RunnerFailure {
  if (e instanceof EngineError && e.kind === 'config') return { retryable: false };
  const status = (e as { cause?: { statusCode?: unknown } } | undefined)?.cause?.statusCode;
  if (typeof status === 'number') return { status, retryable: isRetryableHttp(status) };
  return { retryable: true };
}
