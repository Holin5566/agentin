/**
 * `createAgentEngine` —— 把前三塊接起來。
 *
 * 執行前做靜態檢查(載入、交叉驗證、能力協商),執行時只剩「跑一次」的
 * 紀律:事件編號、串流落盤、逾時、救援、產物提交、清理。
 *
 * 業務決策一律不進來 —— 路由、扇出、reuse 判斷、synth、人工 gate 都是宿主的。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadCatalog } from 'mcp-hub';
import { PROJECT_ROOT } from './shared/paths.js';
import { buildRegistry, createLazyRegistry } from './agents/registry.js';
import { createFileStore } from './artifacts/fileStore.js';
import { execRuntime } from './run/exec.js';
import { createGatewayPool } from './run/gateway.js';
import { claudeCli } from './runtimes/claudeCli.js';
import { createSkillChecker } from './agents/skills.js';
import { collectTools } from './agents/tools.js';
import { statusFor } from './run/status.js';
import {
  EngineError,
  type ArtifactRef, type Engine, type EngineConfig, type RunEvent, type RuntimeEvent,
  type SpawnRuntime, type StopReason, type TakeResult, type TakeSpec, type Usage,
} from './types.js';

/**
 * claude 額度用盡時的退出碼。**這是實測值,不是文件保證的** —— CLI 版本可能改。
 * 之所以值得特別認它:額度用盡跟一般子程序故障的處置相反(不可重試,要等重置),
 * 混在一起的話宿主會一直重試到額度自己恢復為止。
 */
const QUOTA_EXIT_CODE = 88;

/** `close()` 等進行中 take 的上限。等不到就放手,不要讓關閉永遠不回來。 */
const CLOSE_GRACE_MS = 10_000;

/**
 * 把終態翻成錯誤,**並且把 stderr 帶上**。
 *
 * 不帶的話宿主只知道「子程序掛了」,而 stderr 的最後幾行通常就是原因
 * (缺憑證、參數不合法、模型不存在…)。那是實務上最常需要的一行診斷。
 */
function errorFor(reason: StopReason, exec: { exitCode: number | null; stderr: string }, runtime: SpawnRuntime): EngineError {
  const tail = exec.stderr.trim();
  const detail = tail ? ` — stderr: ${tail.slice(-800)}` : '';
  if (reason === 'quota') {
    return new EngineError('quota', `額度用盡(exit ${exec.exitCode})${detail}`);
  }
  if (reason === 'refusal') return new EngineError('runtime', `agent 拒絕繼續${detail}`);
  // runtime 看得懂這次失敗的細節(例如 vercel-ai 的 runner 在 stderr 最後一行留標記)→ 轉成欄位,上層不必解析訊息。
  const failure = runtime.classifyFailure?.(exec);
  return new EngineError('runtime', `子程序失敗(exit ${exec.exitCode})${detail}`, undefined, failure);
}

/**
 * 每個 take 一個發射器:補上 `takeId` / `seq` / `at`,並保證終態只發一次。
 *
 * **宿主的 onEvent 丟例外不會讓 take 失敗** —— 畫不出進度條不該毀掉一次已經
 * 跑完的查詢。(產物落盤失敗是另一回事,那條走 exec 的 onEvent,會讓整次失敗。)
 *
 * sink 依序同步呼叫(engine 層在前、take 層在後),**不 await**:一個卡住的 callback
 * 不能拖住串流,也不能讓 take 收不了尾。一個 sink 丟例外不影響下一個。
 */
function createEmitter(takeId: string, sinks: Array<((e: RunEvent) => void) | undefined>, log?: (line: string) => void) {
  let seq = 0;
  let terminated = false;
  return {
    emit(event: Omit<RunEvent, keyof { takeId: unknown; seq: unknown; at: unknown }>): void {
      if (terminated) {
        // 終態之後晚到的資料只進診斷 log,不再發事件 —— 宿主已經收尾了。
        log?.(`[take ${takeId}] 終態後的晚到事件已忽略: ${(event as any).type}`);
        return;
      }
      if ((event as any).type === 'completed') terminated = true;
      const full = { ...event, takeId, seq: seq++, at: Date.now() } as RunEvent;
      for (const sink of sinks) {
        if (!sink) continue;
        try {
          // 型別是回傳 void,但 async 函式照樣塞得進來 —— 它的 rejection 也要接住,
          // 否則會變成 unhandled rejection。只接,不等。
          const r: unknown = sink(full);
          if (r instanceof Promise) r.catch((e: any) => log?.(`[take ${takeId}] onEvent 非同步失敗(已忽略): ${e?.message}`));
        } catch (e: any) {
          log?.(`[take ${takeId}] onEvent 丟出例外(已忽略): ${e?.message}`);
        }
      }
    },
  };
}

/** `delta` 相加,`cumulative` 取代。adapter 在一次 take 內不可切換模式。 */
function accumulate(into: Usage | undefined, e: Extract<RuntimeEvent, { type: 'usage' }>): Usage {
  if (e.mode === 'cumulative') return e.usage;
  return {
    inputTokens: (into?.inputTokens ?? 0) + (e.usage.inputTokens ?? 0),
    outputTokens: (into?.outputTokens ?? 0) + (e.usage.outputTokens ?? 0),
  };
}

export function createAgentEngine(config: EngineConfig = {}): Engine {
  // 宣告了卻沒作用的欄位比沒有更糟:宿主會以為工具注入成功,模型卻永遠叫不到。
  if (config.builtinTools?.length) {
    throw new EngineError('config',
      'builtinTools 目前不支援:gateway 是另一個程序,收不到宿主的 JS 物件 —— 請改成 stdio MCP server');
  }
  const root = config.root ?? PROJECT_ROOT;
  const runtime = config.runtime ?? claudeCli;
  if (runtime.experimental && !config.allowExperimentalRuntime) {
    throw new EngineError('capability',
      `runtime "${runtime.name}" 還不能用:${runtime.experimental}(開發 adapter 時可設 allowExperimentalRuntime)`);
  }
  // 預設落地到檔案而不是記憶體:記憶體版一重啟就沒了,而宿主可能正靠 `latest()`
  // 判斷要不要重跑 —— 那會變成靜默的資料遺失,比多一個目錄糟得多。
  // 純粹跑完就丟的場景自己傳 `createMemoryStore()`。
  const store = config.artifacts ?? createFileStore({ root: join(root, '.agent-engine', 'artifacts') });
  const log = config.log ?? ((line: string) => process.stderr.write(line + '\n'));
  // 有內建預設,所以「宣告了 skills 卻忘了注入檢查」不再是一個會靜默略過的洞。
  const checkSkill = config.checkSkill ?? createSkillChecker({ projectDir: root });

  // 建立時不做 IO:每個 agent 第一次被用到時才載入並驗證(見 agents/registry.ts)。
  // 上面那幾條(builtinTools、experimental runtime)只看設定,仍然當場擋。
  const registry = createLazyRegistry({
    manifestDir: join(root, 'manifests'),
    runtime,
    catalog: () => loadCatalog(join(root, 'manifests', 'mcp-servers'), collectTools(config.agents ?? [], runtime)),
    ...(config.agents ? { inline: config.agents } : {}),
    ...(config.agentIds ? { agentIds: config.agentIds } : {}),
  });

  const gateways = createGatewayPool();
  /** 進行中的 take:`close()` 要等得到它們,也要能叫它們停。 */
  const inFlight = new Set<{ promise: Promise<unknown>; abort: AbortController }>();
  let closed = false;

  async function runTake(spec: TakeSpec, lifetime: AbortController): Promise<TakeResult> {

    if (!spec.agent || typeof spec.agent !== 'object') throw new EngineError('config', 'runTake requires an agent definition object');
    const agentId = spec.agent.id;
    const takeId = randomUUID();
    const started = spec.startedAt ?? Date.now();
    // registry.get lazily loads + negotiates the agent. Unknown id / engine
    // closed throw EngineError('config') and MUST reject (contract). A lazy
    // capability mismatch (negotiate: skills on a runtime that can't run them,
    // an in-memory tool unreachable, untranslatable capabilities) throws
    // EngineError('capability') — which is a TakeResult error, NOT a rejection,
    // exactly like the skill-precheck path below. Letting it reject would break
    // a host that switches on result.error.kind and strand the angle.
    let agent: ReturnType<typeof registry.get>;
    let toolDefinitions: ReturnType<typeof collectTools>;
    try {
      if (config.agentIds && !config.agentIds.includes(agentId)) throw new EngineError('config', `沒有 agent "${agentId}" —— 不在 agentIds 允許清單`);
      toolDefinitions = collectTools([spec.agent], runtime);
      agent = buildRegistry({
        manifestDir: join(root, 'manifests'), runtime, inline: [spec.agent], inlineOnly: true,
        agentIds: [agentId], catalog: () => loadCatalog(join(root, 'manifests', 'mcp-servers'), toolDefinitions, spec.servers),
      }).get(agentId);
    } catch (e) {
      if (e instanceof EngineError && e.kind === 'capability') {
        const ev = createEmitter(takeId, [config.onEvent, spec.onEvent], log);
        ev.emit({ type: 'started', agent: agentId } as any);
        const elapsedMs = Date.now() - started;
        ev.emit({ type: 'completed', status: 'error', stopReason: 'unknown', elapsedMs, cleanup: 'complete', error: e } as any);
        return {
          takeId, name: agentId, agent: agentId, status: 'error',
          stopReason: 'unknown', output: '', raw: '', elapsedMs, cleanup: 'complete', error: e,
        };
      }
      throw e;
    }
    const name = agent.reportAs ?? agent.id;
    const events = createEmitter(takeId, [config.onEvent, spec.onEvent], log);
    const draft = { takeId };

    const finish = (
      status: TakeResult['status'],
      stopReason: StopReason,
      parts: Partial<TakeResult> = {},
    ): TakeResult => {
      const result: TakeResult = {
        takeId, name, agent: agent.id, status, stopReason,
        output: '', raw: '', elapsedMs: Date.now() - started, cleanup: 'complete',
        ...parts,
      };
      events.emit({
        type: 'completed',
        status, stopReason,
        elapsedMs: result.elapsedMs,
        cleanup: result.cleanup,
        ...(result.error ? { error: result.error } : {}),
        ...(result.artifact ? { artifact: result.artifact } : {}),
      } as any);
      return result;
    };

    events.emit({ type: 'started', agent: agent.id } as any);

    // ── skill 預檢:純讀檔,不 spawn ────────────────────────────────────────
    // plugin 沒註冊時,子程序會卡到逾時才空手而回。10 分鐘的 hang 換成
    // <10ms 的明確錯誤。
    for (const plugin of agent.skills ?? []) {
      const avail = checkSkill(plugin);
      if (!avail.available) {
        const error = new EngineError('capability', `skill "${plugin}" 不可用: ${avail.reason}`);
        return finish('error', 'unknown', { error });
      }
    }

    let usage: Usage | undefined;
    let gateway: ReturnType<typeof gateways.acquire> | undefined;
    let artifact: ArtifactRef | undefined;
    try {
      // 在 try 裡面:`started` 已經發出去了,gateway 開不起來也要走 finish() 補上 `completed`,
      // 否則等 `completed` 的宿主會一直等下去。
      // take 層疊在 engine 層之上:同一個 engine 的並行 take 各自帶自己的值,互不覆蓋。
      const env = config.env || spec.env ? { ...config.env, ...spec.env } : undefined;
      gateway = gateways.acquire({
        agentId: agent.id,
        toolDefinitions,
        servers: spec.servers,
        root,
        ...(agent.tools ? { tools: agent.tools } : {}),
        ...(env ? { env } : {}),
      });
      const built = runtime.command({
        prompt: spec.prompt,
        ...(gateway.configPath ? { mcpConfigPath: gateway.configPath } : {}),
        ...(agent.capabilities ? { capabilities: agent.capabilities } : {}),
        ...(agent.skills ? { skills: agent.skills } : {}),
        ...(spec.model ?? config.defaults?.model ? { model: spec.model ?? config.defaults!.model! } : {}),
      });
      // 子程序在 root 跑,跟 engine 找 manifests 的是同一個地方 —— 不然 agent 看到的相對路徑
      // 會隨宿主從哪裡被啟動而變(bot 的 jira 在 root、bug 在 guardian/)。
      const command = { ...built, cwd: built.cwd ?? root };

      // timeoutMs 是整個 take 的 wall-clock(見 TakeSpec.timeoutMs),從 `started` 起算:
      // 宿主傳了 startedAt(take 之前先做了探測)或 engine 自己的前置花了時間,都從預算裡扣。
      const timeoutMs = spec.timeoutMs ?? config.defaults?.timeoutMs;
      const remainingMs = timeoutMs !== undefined ? Math.max(1, timeoutMs - (Date.now() - started)) : undefined;
      const maxOutputBytes = spec.maxOutputBytes ?? config.defaults?.maxOutputBytes;
      const exec = await execRuntime({
        command,
        ...(runtime.createDecoder ? { decoder: runtime.createDecoder() } : {}),
        signal: lifetime.signal,
        ...(remainingMs !== undefined ? { timeoutMs: remainingMs } : {}),
        ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
        onEvent: async (e) => {
          // 串流落盤**先於**通知宿主:落盤失敗要讓整次失敗(那是證據),
          // 通知失敗不該(那只是進度)。
          if (e.type === 'text') await store.append(draft, e.chunk);
          if (e.type === 'usage') usage = accumulate(usage, e);
          if (e.type !== 'output' && e.type !== 'stopped') events.emit(e as any);
        },
      });

      // 額度用盡在退出碼上有訊號(實測 claude 用 88),而它跟一般子程序故障的
      // 處置相反:不可重試,要等重置。不分開的話宿主會一直重試到額度重置為止。
      // 但取消 / 逾時優先 —— signal-kill 的子程序退出碼通常是 null,不會撞到 88;
      // 真要在同一 tick 自然以 88 退出又正好逾時,「取消 / 逾時」才是宿主該看到的終態
      // (別把一次被砍斷的 take 標成不可重試的 quota)。
      const isTerminal = exec.stopReason === 'cancelled' || exec.stopReason === 'timeout';
      const stopReason: StopReason = exec.exitCode === QUOTA_EXIT_CODE && !isTerminal ? 'quota' : exec.stopReason;
      let status = statusFor(stopReason);
      let raw = exec.text;
      let salvaged = false;

      // 被預算砍斷(逾時 / max_tokens / max_turn_requests)時,宿主的判準說了算。
      if (status === 'truncated' && spec.salvage) {
        const rescued = spec.salvage(raw);
        if (rescued !== null) { raw = rescued; status = 'ok'; salvaged = true; }
      }

      let output = raw;
      if (status === 'ok' && spec.parseOutput) {
        try {
          output = spec.parseOutput(raw);
        } catch (e: any) {
          return finish('error', stopReason, {
            raw, output: raw, cleanup: exec.cleanup, ...(usage ? { usage } : {}),
            error: new EngineError('output', `parseOutput 失敗: ${e?.message ?? e}`, e),
          });
        }
      }

      // **只有成功才落地正式產物。** 失敗或中斷的部分輸出一旦落地,下次 reuse
      // 會撈到髒內容,而那比沒有產物難查得多。
      if (status === 'ok') {
        artifact = await store.commit(draft, { name, ...(spec.scope ? { scope: spec.scope } : {}) }, output);
      }

      return finish(status, stopReason, {
        raw, output, cleanup: exec.cleanup,
        ...(usage ? { usage } : {}),
        ...(artifact ? { artifact } : {}),
        ...(salvaged ? { salvaged } : {}),
        // 失敗時把 stderr 帶出來 —— 不帶的話宿主只知道「子程序掛了」,
        // 而那是實務上最常需要的那一行診斷。
        ...(status === 'error' ? { error: errorFor(stopReason, exec, runtime) } : {}),
      });
    } catch (e: any) {
      const error = e instanceof EngineError ? e : new EngineError('runtime', e?.message ?? String(e), e);
      // execRuntime attaches the reaped cleanup to the rejection (see exec.ts
      // fail): a store.append failure that had to SIGKILL a tool-holding
      // grandchild rejects as 'unconfirmed' and must NOT default to 'complete'.
      const cleanup: TakeResult['cleanup'] = e?.cleanup === 'unconfirmed' ? 'unconfirmed' : 'complete';
      return finish('error', 'unknown', { error, cleanup, ...(usage ? { usage } : {}) });
    } finally {
      gateway?.close();
      // 成功的 take 在 commit 時已經收掉 draft;其餘(失敗、取消、截斷)在這裡丟,不然 drafts/
      // 會一直長。丟不掉不影響結果 —— 那只是暫存。
      if (!artifact) await store.discard?.(draft).catch(() => {});
    }
  }

  return {
    /** 包一層:記錄進行中,讓 `close()` 等得到也叫得停。 */
    runTake(spec: TakeSpec): Promise<TakeResult> {
      if (closed) return Promise.reject(new EngineError('config', 'engine 已關閉'));
      const abort = new AbortController();
      // 宿主自己的 signal 與 engine 的關閉,任一個觸發都停。
      // take 結束就拿掉 listener:宿主可能拿同一個 signal 跑很多次 take(例如整個 thread 共用一個)。
      const onAbort = () => abort.abort();
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      if (spec.signal?.aborted) abort.abort();

      const entry = { promise: Promise.resolve() as Promise<unknown>, abort };
      entry.promise = runTake(spec, abort).finally(() => {
        inFlight.delete(entry);
        spec.signal?.removeEventListener('abort', onAbort);
      });
      inFlight.add(entry);
      return entry.promise as Promise<TakeResult>;
    },

    /**
     * 關閉。**會等進行中的 take**,而不是設個旗標就回去 —— 後者會讓宿主以為
     * 關乾淨了,實際上還有子程序在跑、還在寫產物。
     *
     * 先叫它們停,再等;等不到就在期限後放手,並把還沒收掉的暫存設定檔補收。
     */
    check(): string[] {
      return registry.check();
    },

    async close(): Promise<void> {
      closed = true;
      for (const { abort } of inFlight) abort.abort();
      if (inFlight.size > 0) {
        const pending = [...inFlight].map((e) => e.promise.catch(() => {}));
        await Promise.race([
          Promise.all(pending),
          new Promise((r) => setTimeout(r, CLOSE_GRACE_MS).unref?.()),
        ]);
      }
      // take 在 finally 之前就炸掉時會留下暫存設定檔,這裡補收。
      gateways.closeAll();
    },
  };
}
