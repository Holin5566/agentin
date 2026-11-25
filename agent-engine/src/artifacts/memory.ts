/**
 * 記憶體 `ArtifactStore`。測試的替身,以及「跑完就用掉」的宿主自己傳進來用。
 *
 * **它不持久化** —— 程序結束就沒了。engine 的預設是 `createFileStore`(寫在
 * `<root>/.agent-engine/artifacts`),不是這個:宿主可能靠 `latest()` 判斷要不要重跑,
 * 預設成記憶體版的話,一重啟就變成靜默的資料遺失。
 */
import { EngineError, type ArtifactKey, type ArtifactRef, type ArtifactStore, type DraftRef } from '../types.js';

const keyOf = (k: ArtifactKey): string => `${k.scope ?? ''}\u0000${k.name}`;

interface Version { version: string; content: string; superseded: boolean }

export function createMemoryStore(): ArtifactStore {
  /** take 進行中的串流緩衝,以 takeId 隔離 —— 重跑不會跟上一次黏在一起。 */
  const drafts = new Map<string, string>();
  const versions = new Map<string, Version[]>();
  /** 記住每個 draft 提交過什麼,用來實現冪等與偵測矛盾。 */
  const commits = new Map<string, { key: string; content: string; ref: ArtifactRef }>();

  return {
    async append(ref: DraftRef, chunk: string): Promise<void> {
      drafts.set(ref.takeId, (drafts.get(ref.takeId) ?? '') + chunk);
    },

    async readPartial(ref: DraftRef): Promise<string | null> {
      return drafts.get(ref.takeId) ?? null;
    },

    async commit(draft: DraftRef, key: ArtifactKey, content: string): Promise<ArtifactRef> {
      const prior = commits.get(draft.takeId);
      if (prior) {
        // 同一次 take 重複提交同樣的東西是冪等的(重試收尾之類);但提交**不同**
        // 內容代表呼叫端搞錯了 —— 靜默接受會讓「哪一版才算數」變成未定義。
        if (prior.key === keyOf(key) && prior.content === content) return prior.ref;
        throw new EngineError('config', `take ${draft.takeId} 已經提交過不同內容的產物`);
      }

      const list = versions.get(keyOf(key)) ?? [];
      const ref: ArtifactRef = { ...key, version: `v${list.length + 1}` };
      list.push({ version: ref.version, content, superseded: false });
      versions.set(keyOf(key), list);
      commits.set(draft.takeId, { key: keyOf(key), content, ref });
      drafts.delete(draft.takeId);
      return ref;
    },

    async discard(draft: DraftRef): Promise<void> {
      drafts.delete(draft.takeId);
    },

    async read(ref: ArtifactRef): Promise<string | null> {
      const found = versions.get(keyOf(ref))?.find((v) => v.version === ref.version);
      // 作廢的版本仍然讀得到 —— supersede 是「別再拿它當最新」,不是刪除。
      return found?.content ?? null;
    },

    async latest(key: ArtifactKey): Promise<ArtifactRef | null> {
      const list = versions.get(keyOf(key)) ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (!list[i].superseded) return { ...key, version: list[i].version };
      }
      return null;
    },

    async supersede(ref: ArtifactRef): Promise<void> {
      const found = versions.get(keyOf(ref))?.find((v) => v.version === ref.version);
      if (!found) throw new EngineError('config', `要作廢的版本不存在: ${ref.name}@${ref.version}`);
      found.superseded = true;
    },
  };
}
