import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileStore } from '../artifacts/fileStore.js';
import type { ArtifactStore } from '../types.js';

let root: string;
let store: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-engine-store-'));
  store = createFileStore({ root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('draft 串流', () => {
  it('邊收邊落盤,讀得到「當下為止」的內容', async () => {
    // 逾時救援與 tail -F 都靠這個 —— 累積在記憶體最後才寫,兩者都做不到。
    await store.append({ takeId: 't1' }, 'first ');
    expect(await store.readPartial({ takeId: 't1' })).toBe('first ');
    await store.append({ takeId: 't1' }, 'second');
    expect(await store.readPartial({ takeId: 't1' })).toBe('first second');
  });

  it('不同 take 的 draft 互不干擾', async () => {
    // 這是 DraftRef 以 takeId 隔離的理由:重跑不會跟上一次的輸出黏在一起,
    // 否則 salvage 的「有沒有完整 marker」判準會救回一份混血報告。
    await store.append({ takeId: 'a' }, 'AAA');
    await store.append({ takeId: 'b' }, 'BBB');
    expect(await store.readPartial({ takeId: 'a' })).toBe('AAA');
    expect(await store.readPartial({ takeId: 'b' })).toBe('BBB');
  });

  it('沒有 draft 時回 null 而不是空字串', async () => {
    expect(await store.readPartial({ takeId: 'never' })).toBeNull();
  });
});

describe('discard', () => {
  it('沒成功的 take 丟掉 draft;keepDrafts 時留著(那正是最需要看的)', async () => {
    await store.append({ takeId: 'failed' }, 'partial');
    await store.discard!({ takeId: 'failed' });
    expect(await store.readPartial({ takeId: 'failed' })).toBeNull();

    const keeper = createFileStore({ root, keepDrafts: true });
    await keeper.append({ takeId: 'kept' }, 'partial');
    await keeper.discard!({ takeId: 'kept' });
    expect(await keeper.readPartial({ takeId: 'kept' })).toBe('partial');
  });
});

describe('版本化提交', () => {
  it('提交回不可變 ref,內容讀得回來', async () => {
    const ref = await store.commit({ takeId: 't1' }, { name: 'report' }, 'hello');
    expect(ref).toMatchObject({ name: 'report', version: 'v1' });
    expect(await store.read(ref)).toBe('hello');
  });

  it('重跑產生新版本,不覆寫舊的', async () => {
    const v1 = await store.commit({ takeId: 't1' }, { name: 'report' }, 'first');
    const v2 = await store.commit({ takeId: 't2' }, { name: 'report' }, 'second');
    expect([v1.version, v2.version]).toEqual(['v1', 'v2']);
    expect(await store.read(v1)).toBe('first');
    expect(await store.read(v2)).toBe('second');
  });

  it('不同 scope 各自編號,不互相影響', async () => {
    const a = await store.commit({ takeId: 'x' }, { scope: 'thread-1', name: 'r' }, 'A');
    const b = await store.commit({ takeId: 'y' }, { scope: 'thread-2', name: 'r' }, 'B');
    expect([a.version, b.version]).toEqual(['v1', 'v1']);
    expect(await store.read(a)).toBe('A');
  });

  it('同一 draft 重複提交相同內容是冪等的', async () => {
    const first = await store.commit({ takeId: 't1' }, { name: 'r' }, 'same');
    const again = await store.commit({ takeId: 't1' }, { name: 'r' }, 'same');
    expect(again).toEqual(first);
    // 不該產生第二個版本。
    expect(await store.read({ name: 'r', version: 'v2' })).toBeNull();
  });

  it('同一 draft 提交不同內容要拒絕', async () => {
    // 靜默接受會讓「哪一版才算數」變成未定義。
    await store.commit({ takeId: 't1' }, { name: 'r' }, 'one');
    await expect(store.commit({ takeId: 't1' }, { name: 'r' }, 'two'))
      .rejects.toThrow(/已經提交過不同內容/);
  });

  it('提交後預設清掉 draft —— drafts/ 不能無限長大', async () => {
    await store.append({ takeId: 't1' }, 'stream');
    await store.commit({ takeId: 't1' }, { name: 'r' }, 'parsed');
    expect(await store.readPartial({ takeId: 't1' })).toBeNull();
  });

  it('keepDrafts 打開時保留原始串流供事後比對', async () => {
    const keeper = createFileStore({ root, keepDrafts: true });
    await keeper.append({ takeId: 'k' }, 'raw stream');
    await keeper.commit({ takeId: 'k' }, { name: 'r' }, 'parsed output');
    // 原始串流與解析後的產物不同,除錯時前者有價值。
    expect(await keeper.readPartial({ takeId: 'k' })).toBe('raw stream');
  });
});

describe('並行提交', () => {
  it('同時提交到同一個 key 不會互相蓋掉', async () => {
    // 沒有索引檔就是為了這個:read-modify-write 的索引會讓兩個並行的 take
    // 拿到同一個版本號。
    const takes = Array.from({ length: 12 }, (_, i) => i);
    const refs = await Promise.all(takes.map((i) =>
      store.commit({ takeId: `t${i}` }, { name: 'hot' }, `content-${i}`)));

    const versions = refs.map((r) => r.version);
    expect(new Set(versions).size).toBe(takes.length);
    // 每一份內容都還在,而且配對正確。
    for (let i = 0; i < takes.length; i++) {
      expect(await store.read(refs[i])).toBe(`content-${i}`);
    }
  });
});

describe('latest 與 supersede', () => {
  it('latest 給最新的未作廢版本', async () => {
    await store.commit({ takeId: 'a' }, { name: 'r' }, '1');
    const v2 = await store.commit({ takeId: 'b' }, { name: 'r' }, '2');
    expect(await store.latest({ name: 'r' })).toEqual(v2);
  });

  it('作廢之後 latest 退回上一版,但被作廢的仍讀得到', async () => {
    // supersede 是「別再拿它當最新」,不是刪除 —— 已經拿著 ref 的宿主要讀得到。
    const v1 = await store.commit({ takeId: 'a' }, { name: 'r' }, 'good');
    const v2 = await store.commit({ takeId: 'b' }, { name: 'r' }, 'bad');
    await store.supersede(v2);

    expect(await store.latest({ name: 'r' })).toEqual(v1);
    expect(await store.read(v2)).toBe('bad');
  });

  it('沒有任何版本時 latest 回 null', async () => {
    expect(await store.latest({ name: 'nothing' })).toBeNull();
  });

  it('作廢不存在的版本要報錯', async () => {
    await expect(store.supersede({ name: 'r', version: 'v9' })).rejects.toThrow(/不存在/);
  });
});

describe('路徑安全', () => {
  it('scope 不能逃出 root', async () => {
    // 不擋的話 '../../etc' 就寫到外面去了。
    await expect(store.commit({ takeId: 't' }, { scope: '../../etc', name: 'passwd' }, 'x'))
      .rejects.toThrow(/不是合法的路徑片段/);
  });

  it('name 含路徑分隔字元要拒絕,而不是消音改寫', async () => {
    // 靜默改名會讓兩個不同的 name 撞在一起。
    await expect(store.commit({ takeId: 't' }, { name: 'a/b' }, 'x'))
      .rejects.toThrow(/不是合法的路徑片段/);
  });

  it('takeId 也要驗 —— 它同樣變成檔名', async () => {
    await expect(store.append({ takeId: '../escape' }, 'x'))
      .rejects.toThrow(/不是合法的路徑片段/);
  });

  it('真實的 scope 形狀過得了', async () => {
    // Guardian 的 threadTs 與 e2e 的 <issueKey>-<threadId>。
    for (const scope of ['1758600000.123456', 'AS-3289-thread42']) {
      const ref = await store.commit({ takeId: `t-${scope}` }, { scope, name: 'sub-code-tracer' }, 'ok');
      expect(await store.read(ref)).toBe('ok');
    }
  });
});

describe('磁碟版面', () => {
  it('版本是真的檔案,人看得懂也 grep 得到', async () => {
    const ref = await store.commit({ takeId: 't' }, { scope: 'thread-1', name: 'report' }, 'content here');
    const path = join(root, 'thread-1', 'report', 'v1');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('content here');
  });

  it('沒有 scope 時落在 _ 底下,不跟有 scope 的混在一起', async () => {
    await store.commit({ takeId: 't' }, { name: 'report' }, 'x');
    expect(existsSync(join(root, '_', 'report', 'v1'))).toBe(true);
  });

  it('不留暫存檔', async () => {
    await store.commit({ takeId: 't' }, { name: 'r' }, 'x');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(root, '_', 'r')).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });
});
