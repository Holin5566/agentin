/**
 * `StopReason` → `TakeStatus`:「為什麼停」翻成「宿主該怎麼處置」。
 *
 * 這是一段很短但很容易寫錯的邏輯,所以獨立成純函式並釘住測試 —— 錯一格的後果
 * 是宿主對整整一類結果做錯決定(例如把可救的 partial 當失敗丟掉)。
 */
import type { StopReason, TakeStatus } from '../types.js';

/**
 * 分類的判準是**宿主接下來要做什麼**,不是技術成因:
 *
 * - `ok` 用結果
 * - `truncated` 試著 salvage,救不回才當失敗
 * - `error` 這一路失敗,降級整合
 * - `cancelled` 不算失敗
 *
 * 「被預算砍斷」歸在一起是刻意的:逾時、token 用完、單輪請求次數用完、輸出
 * 超量,對宿主而言是同一件事 —— **跑到一半被切斷,但可能已經吐出有用的東西**。
 * 只認得逾時一種,其餘就會被當成一般失敗而不去 salvage。
 *
 * `quota` **不在那一組**:額度用盡時重試與 salvage 都沒意義,要等重置。
 */
export function statusFor(reason: StopReason): TakeStatus {
  switch (reason) {
    case 'end_turn':
      return 'ok';
    case 'timeout':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'max_output':
    case 'context_exceeded':
    case 'reasoning_budget':
      return 'truncated';
    case 'cancelled':
      return 'cancelled';
    case 'refusal':
    case 'quota':
    case 'unknown':
      return 'error';
  }
}

/** 這個終態值不值得叫 `salvage`。 */
export function isSalvageable(reason: StopReason): boolean {
  return statusFor(reason) === 'truncated';
}
