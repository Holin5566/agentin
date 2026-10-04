import { describe, expect, it } from 'vitest';
import { parseArgs, parseCheckArgs } from '../bin/args.js';

/**
 * `parseCheckArgs` 在補 `check.ts` 之前沒有任何呼叫端,也就沒人發現它壞了沒。
 * 這裡釘住它的行為,重點在「跟 gateway 的 parseArgs 不同:檢查全部是安全預設」。
 */
describe('parseCheckArgs', () => {
  it('沒給參數 = 檢查全部', () => {
    expect(parseCheckArgs([])).toEqual({ listTools: false });
  });

  it('--server 收逗號分隔,也可以給多次', () => {
    expect(parseCheckArgs(['--server', 'jira,playwright'])).toEqual({
      only: ['jira', 'playwright'], listTools: false,
    });
    expect(parseCheckArgs(['--server', 'jira', '--server', 'playwright'])).toEqual({
      only: ['jira', 'playwright'], listTools: false,
    });
  });

  it('--list-tools 是旗標,不吃後面的值', () => {
    expect(parseCheckArgs(['--list-tools', '--server', 'jira'])).toEqual({
      only: ['jira'], listTools: true,
    });
  });

  it('--server 沒給值就報錯 —— 靜默變成「檢查全部」會讓人以為指定生效了', () => {
    expect(() => parseCheckArgs(['--server'])).toThrow(/--server 需要至少一個 server id/);
    expect(() => parseCheckArgs(['--server', '--list-tools'])).toThrow(/--server 需要至少一個/);
  });

  it('未知旗標報錯,不默默忽略', () => {
    expect(() => parseCheckArgs(['--serrver', 'jira'])).toThrow(/未知參數 --serrver/);
  });
});

/**
 * gateway 入口的範圍參數。hub 不知道 agent 是什麼 —— 允許清單由呼叫端算好傳進來。
 */
describe('parseArgs', () => {
  it('--tools 收逗號分隔的允許清單', () => {
    expect(parseArgs(['--tools', 'up-echo,up-fail'])).toEqual({ tools: ['up-echo', 'up-fail'] });
  });

  it('--tools 給空值 = 空的允許清單,不是不限制', () => {
    expect(parseArgs(['--tools', ''])).toEqual({ tools: [] });
    expect(parseArgs(['--tools'])).toEqual({ tools: [] });
  });

  it('--all-tools 必須明寫', () => {
    expect(parseArgs(['--all-tools'])).toEqual({ allTools: true });
  });

  it('沒指定範圍直接報錯,不默認全開', () => {
    expect(() => parseArgs([])).toThrow(/必須指定工具範圍/);
  });

  it('--tools 與 --all-tools 只能擇一', () => {
    expect(() => parseArgs(['--tools', 'up-echo', '--all-tools'])).toThrow(/只能擇一/);
  });

  it('--agent 已移除,錯誤訊息講清楚改用 --tools', () => {
    expect(() => parseArgs(['--agent', 'code-tracer'])).toThrow(/--agent 已移除.*--tools/);
  });
});

describe('parseArgs — 多餘的參數', () => {
  it('`--tools a b` 的 b 不能靜默消失:呼叫端以為開了,agent 卻沒有', () => {
    expect(() => parseArgs(['--tools', 'a', 'b'])).toThrow(/多餘的參數 b.*逗號/);
    expect(() => parseArgs(['--all-tools', 'x'])).toThrow(/多餘的參數 x/);
    expect(parseArgs(['--tools', 'a,b'])).toMatchObject({ tools: ['a', 'b'] });
  });
});
