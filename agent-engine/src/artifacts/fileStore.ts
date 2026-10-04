/**
 * 檔案系統 `ArtifactStore`。
 *
 * 版面:
 * ```
 * <root>/
 *   drafts/<takeId>.partial.log     ← 串流中的原始輸出(tail -F 看得到)
 *   <scope>/<name>/v1               ← 已提交的不可變版本
 *   <scope>/<name>/v2
 *   <scope>/<name>/v2.superseded    ← 作廢標記,內容仍留著
 * ```
 *
 * **沒有索引檔。** 版本清單就是目錄內容,作廢就是一個標記檔 —— 索引檔會引入
 * read-modify-write,兩個並行的 take 提交到同一個 key 時會互相蓋掉。
 */
import { constants } from 'node:fs';
import { appendFile, link, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EngineError, type ArtifactKey, type ArtifactRef, type ArtifactStore, type DraftRef } from '../types.js';

/**
 * `scope` 與 `name` 會變成路徑片段,而它們來自 manifest 與宿主。
 *
 * 不擋的話,一個 `scope: '../../etc'` 就寫到 root 外面去了。白名單比黑名單可靠:
 * 只收字母數字與少數符號,其餘一律拒絕(而不是消音改寫 —— 靜默改名會讓兩個
 * 不同的 scope 撞在一起)。
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function segment(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new EngineError('config', `${what} 不是合法的路徑片段: ${JSON.stringify(value)}`);
  }
  return value;
}

const VERSION = /^v(\d+)$/;

export interface FileStoreOpts {
  /** 產物根目錄。 */
  root: string;
  /**
   * 提交成功後是否保留 draft 的原始串流。
   *
   * 預設刪掉:`drafts/` 以 takeId 命名,長命的宿主程序放著不管會無限長大。
   * 要留原始串流做事後比對的宿主自己打開它,並負責清理。
   */
  keepDrafts?: boolean;
}

export function createFileStore(o: FileStoreOpts): ArtifactStore {
  const draftPath = (ref: DraftRef) =>
    join(o.root, 'drafts', `${segment(ref.takeId, 'takeId')}.partial.log`);
  const keyDir = (key: ArtifactKey) =>
    join(o.root, key.scope ? segment(key.scope, 'scope') : '_', segment(key.name, 'name'));

  /** 同一個 draft 提交過什麼,用來實現冪等與偵測矛盾。程序內有效就夠 —— takeId 不跨重啟。 */
  const commits = new Map<string, { dir: string; content: string; ref: ArtifactRef }>();

  /**
   * 原子地佔住一個版本號並同時發布內容。
   *
   * `link()` 在目標已存在時會失敗,所以「配號」與「寫入」是同一個動作 ——
   * 不必加鎖,跨程序也成立。先寫暫存檔再 link,避免別人讀到寫到一半的內容。
   */
  async function publish(dir: string, content: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${randomUUID()}`);
    await writeFile(tmp, content, 'utf8');
    try {
      for (let n = (await highestVersion(dir)) + 1; ; n++) {
        try {
          await link(tmp, join(dir, `v${n}`));
          return `v${n}`;
        } catch (e: any) {
          // EEXIST = 有人剛好搶到這個號碼,往下一號試。
          if (e?.code !== 'EEXIST') throw e;
        }
      }
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  async function versionsIn(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((f) => VERSION.test(f));
    } catch (e: any) {
      if (e?.code === 'ENOENT') return [];
      throw e;
    }
  }

  async function highestVersion(dir: string): Promise<number> {
    const nums = (await versionsIn(dir)).map((v) => Number(VERSION.exec(v)![1]));
    return nums.length > 0 ? Math.max(...nums) : 0;
  }

  return {
    async append(ref: DraftRef, chunk: string): Promise<void> {
      const path = draftPath(ref);
      await mkdir(join(o.root, 'drafts'), { recursive: true });
      // append 而不是累積在記憶體再一次寫 —— 逾時救援要讀得到「當下為止」的內容,
      // 而且 tail -F 看得到子程序在幹嘛。
      await appendFile(path, chunk, 'utf8');
    },

    async readPartial(ref: DraftRef): Promise<string | null> {
      try {
        return await readFile(draftPath(ref), 'utf8');
      } catch (e: any) {
        if (e?.code === 'ENOENT') return null;
        throw e;
      }
    },

    async commit(draft: DraftRef, key: ArtifactKey, content: string): Promise<ArtifactRef> {
      const dir = keyDir(key);
      const prior = commits.get(draft.takeId);
      if (prior) {
        // 重複提交同樣的東西是冪等的(收尾重試之類);提交**不同**內容代表呼叫端
        // 搞錯了 —— 靜默接受會讓「哪一版才算數」變成未定義。
        if (prior.dir === dir && prior.content === content) return prior.ref;
        throw new EngineError('config', `take ${draft.takeId} 已經提交過不同內容的產物`);
      }

      const version = await publish(dir, content);
      const ref: ArtifactRef = { ...key, version };
      commits.set(draft.takeId, { dir, content, ref });
      if (!o.keepDrafts) await unlink(draftPath(draft)).catch(() => {});
      return ref;
    },

    async discard(draft: DraftRef): Promise<void> {
      if (o.keepDrafts) return; // 要保留原始串流的設定下,沒成功的也留著(正是最需要看的)
      await unlink(draftPath(draft)).catch(() => {});
    },

    async read(ref: ArtifactRef): Promise<string | null> {
      try {
        // 作廢的版本仍然讀得到 —— supersede 是「別再拿它當最新」,不是刪除。
        return await readFile(join(keyDir(ref), segment(ref.version, 'version')), 'utf8');
      } catch (e: any) {
        if (e?.code === 'ENOENT') return null;
        throw e;
      }
    },

    async latest(key: ArtifactKey): Promise<ArtifactRef | null> {
      const dir = keyDir(key);
      const all = await versionsIn(dir);
      const marks = new Set((await readdir(dir).catch(() => [] as string[]))
        .filter((f) => f.endsWith('.superseded'))
        .map((f) => f.slice(0, -'.superseded'.length)));

      const live = all.filter((v) => !marks.has(v))
        .sort((a, b) => Number(VERSION.exec(a)![1]) - Number(VERSION.exec(b)![1]));
      const newest = live.at(-1);
      return newest ? { ...key, version: newest } : null;
    },

    async supersede(ref: ArtifactRef): Promise<void> {
      const dir = keyDir(ref);
      const version = segment(ref.version, 'version');
      if (!(await versionsIn(dir)).includes(version)) {
        throw new EngineError('config', `要作廢的版本不存在: ${ref.name}@${version}`);
      }
      // 標記檔而不是改名:改名會讓已經拿著 ref 的宿主讀不到,而 read() 的契約是
      // 「固定版本讀得到」。
      await writeFile(join(dir, `${version}.superseded`), '', { flag: constants.O_CREAT | constants.O_WRONLY });
    },
  };
}
