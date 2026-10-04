import { describe, expect, it } from 'vitest';
import { EngineError } from '../types.js';
import { classifyFailure, encodeFailure, isRetryableHttp, parseRunnerFailure } from '../runtimes/vercelAi/protocol.js';

describe('失敗標記', () => {
  it('encode → parse 往返;標記在 stderr 尾端(前面有別的訊息)也找得到', () => {
    const f = { status: 401, retryable: false };
    expect(parseRunnerFailure(`子程序失敗 — stderr: 模型呼叫失敗:HTTP 401\n${encodeFailure(f)}`)).toEqual(f);
  });

  it('多個標記取最後一個;沒有或壞掉 = undefined(不猜)', () => {
    const text = `${encodeFailure({ retryable: true })}後來又失敗\n${encodeFailure({ retryable: false })}`;
    expect(parseRunnerFailure(text)).toEqual({ retryable: false });
    expect(parseRunnerFailure('HTTP 401: nope')).toBeUndefined();
    expect(parseRunnerFailure('@@runner-failure {壞')).toBeUndefined();
    expect(parseRunnerFailure('@@runner-failure {"status":401}')).toBeUndefined(); // 缺 retryable
  });

  it('重試政策:400 / 401 / 403 / 404 / 422 不重試;429 / 408 / 5xx / 沒有狀態碼重試', () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableHttp(s)).toBe(false);
    for (const s of [408, 429, 500, 502, 503, undefined]) expect(isRetryableHttp(s)).toBe(true);
  });

  it('classifyFailure:config 錯誤、帶 statusCode 的模型端錯誤、其他', () => {
    expect(classifyFailure(new EngineError('config', 'x'))).toEqual({ retryable: false });
    expect(classifyFailure(new EngineError('runtime', 'x', { statusCode: 401 }))).toEqual({ status: 401, retryable: false });
    expect(classifyFailure(new EngineError('runtime', 'x', { statusCode: 503 }))).toEqual({ status: 503, retryable: true });
    expect(classifyFailure(new Error('ECONNREFUSED'))).toEqual({ retryable: true });
  });
});
