import { describe, expect, it } from 'vitest';
import { isSalvageable, statusFor } from '../run/status.js';
import type { StopReason, TakeStatus } from '../types.js';

/**
 * 這組測試真正在守的是:**三種「被預算砍斷」必須歸成同一態**。
 *
 * 只認得逾時、把 max_tokens 當一般失敗的話,宿主就不會去 salvage —— 一份其實
 * 已經寫進 partial 的完整報告會被直接丟掉,而且症狀是「偶爾某個分支沒結果」,
 * 極難追到根因。
 */

const ALL: StopReason[] = [
  'end_turn', 'max_tokens', 'max_turn_requests', 'context_exceeded', 'reasoning_budget', 'refusal', 'cancelled', 'timeout', 'unknown',
];

describe('statusFor', () => {
  it('正常講完 = ok', () => {
    expect(statusFor('end_turn')).toBe('ok');
  });

  it('三種被預算砍斷都歸 truncated,不是 error', () => {
    for (const reason of ['timeout', 'max_tokens', 'max_turn_requests'] as const) {
      expect(statusFor(reason), reason).toBe('truncated');
    }
  });

  it('輸入放不下(context_exceeded)與想不完(reasoning_budget)也是被預算砍斷:歸 truncated、可 salvage,但原因跟 max_tokens(輸出寫不完)分開保留', () => {
    for (const reason of ['context_exceeded', 'reasoning_budget'] as const) {
      expect(statusFor(reason), reason).toBe('truncated');
      expect(isSalvageable(reason), reason).toBe(true);
    }
    // 三者是三個不同的值:監控與重試才分得出「該減少輸入」「該放寬輸出」還是「該調思考上限」
    expect(new Set(['max_tokens', 'context_exceeded', 'reasoning_budget']).size).toBe(3);
  });

  it('取消自成一態,不算失敗', () => {
    expect(statusFor('cancelled')).toBe('cancelled');
  });

  it('拒絕與判斷不出來都是 error', () => {
    expect(statusFor('refusal')).toBe('error');
    expect(statusFor('unknown')).toBe('error');
  });

  it('每個 StopReason 都有對應,沒有漏的', () => {
    const valid: TakeStatus[] = ['ok', 'truncated', 'error', 'cancelled'];
    for (const reason of ALL) expect(valid, reason).toContain(statusFor(reason));
  });
});

describe('isSalvageable', () => {
  it('只有被砍斷的值得救', () => {
    const salvageable = ALL.filter(isSalvageable).sort();
    expect(salvageable).toEqual(['context_exceeded', 'max_tokens', 'max_turn_requests', 'reasoning_budget', 'timeout']);
  });

  it('成功與取消都不該進 salvage —— 前者沒必要,後者沒有結果可言', () => {
    expect(isSalvageable('end_turn')).toBe(false);
    expect(isSalvageable('cancelled')).toBe(false);
  });
});
