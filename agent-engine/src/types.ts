/**
 * Engine 的公開型別。這個檔只放型別,實作在 `engine.ts` / `exec.ts` / `runtimes/` 等。
 *
 * 設計依據見 `docs/engine-journey.md`(用戶旅程與注入收斂)與
 * `docs/caller-shapes.md`(兩條真實流程的 take 邊界)。
 *
 * 一句話:engine 把一份 agent 宣告兌現成一次可觀測、可取消、有工具邊界的執行。
 * 它不持有 prompt、不決定下一步、不做編排。
 */
import type { BuiltinTool, ToolDecl } from 'mcp-hub';
import type { AgentCapabilities, AgentDefinition } from './agents/manifest.js';

// ─── 能力 ────────────────────────────────────────────────────────────────

/**
 * agent 宣告的能力需求(寫意圖不寫旗標)。
 *
 * 定義在 `agents/manifest.ts` —— 它是 manifest schema 的一部分,而
 * `shared/` 不該反過來依賴 `engine/`。這裡只轉出去,讓宿主從單一入口拿到。
 */
export type { AgentCapabilities };

/**
 * runtime 提供得了什麼。用來做能力協商 —— runtime 在建立 engine 時就決定,所以每個
 * agent 在 spawn 之前就能驗(第一次被用到時,或 boot 時 `engine.check()` 一次驗完),
 * 不必等到某個 take 跑了十分鐘才發現它要的東西這個 runtime 給不起。
 */
export interface RuntimeCapabilities {
  /** claude 的 plugin/skill 機制。只有 claude 有。 */
  skills: boolean;
  /** 模型自帶的原生工具(Read / Bash / Glob…)。裸接家族沒有。 */
  nativeTools: boolean;
  /** 怎麼表達檔案系統限制。`none` = 表達不了(宣告了就拒絕)。 */
  filesystemPolicy: 'tool-list' | 'sandbox' | 'none';
  /** 能不能精確限制步數。只有裸接家族觀測得到。 */
  maxSteps: boolean;
}

// ─── Runtime ─────────────────────────────────────────────────────────────

/** adapter 要組指令時拿得到的東西。 */
export interface CommandContext {
  prompt: string;
  /** engine 已經寫好的 gateway 設定檔路徑;agent 沒宣告 tools 時是 undefined。 */
  mcpConfigPath?: string;
  capabilities?: AgentCapabilities;
  /**
   * agent 宣告的 skills(已通過預檢)。省略 = 沒宣告。
   *
   * 旗標跟著 agent 走,不是跟著每次呼叫走 —— 例如 claude adapter 對沒宣告 skills 的
   * agent 一律加 `--disable-slash-commands`。
   */
  skills?: string[];
  model?: string;
}

export interface SpawnCommand {
  file: string;
  args: string[];
  /**
   * 疊在 process.env 之上,不是取代。值為 `undefined` = **從繼承的環境拿掉這個變數**。
   *
   * 要能拿掉,是因為宿主 process 常帶著不該給子程序的東西 —— 例如 `ANTHROPIC_API_KEY`
   * 會讓 `claude -p` 靜默改走計費 API,而不是訂閱。
   */
  env?: Record<string, string | undefined>;
  /** 子程序的工作目錄。adapter 通常不填,由 engine 補成 `EngineConfig.root`。 */
  cwd?: string;
  /**
   * 寫進子程序 stdin 後關閉。省略 = 子程序的 stdin 立刻 EOF。
   *
   * prompt 走這裡而不是 argv:argv 有長度上限(bug evidence 動輒幾百 KB),而且開頭是 `-`
   * 的 prompt(一份 markdown 清單)會被 CLI 當成 option —— 實測 claude 回 `unknown option`。
   */
  stdin?: string;
}

/**
 * **子程序家族**的執行方式:`claude -p`、`codex exec` 這類自帶 agent loop 的 CLI。
 *
 * **宣告式** —— adapter 只說「該執行什麼指令」,engine 負責 spawn、串流、逾時、
 * 取消(含 process group kill)、產物落盤、發事件。
 *
 * 為什麼不讓 adapter 自己 spawn:那樣取消與 process group kill 要在每個 adapter
 * 重寫一次,而那正是要收斂掉的東西。代價是 adapter 很薄 —— 這是刻意的。
 *
 * ⚠️ **這個型別表達的是「spawn 一個 binary」。** 裸模型沒有 agent loop,由我們自己的 runner
 * 子程序(`runtimes/vercelAi/runner.ts`)跑 tool loop、扮演 `claude -p`,所以它也是一個 `SpawnRuntime`。
 * 塞不進這個形狀的是「engine 進程內自己驅動迴圈」或 SDK 形式的 runtime。名字叫 `SpawnRuntime` 而不是
 * `Runtime` 就是要讓這個限制寫在型別上,而不是只寫在文件裡。
 *
 * 真的需要 engine 層級的細節(每步事件、builtin tools)時,才會變成
 * `type Runtime = SpawnRuntime | LoopRuntime`,屆時把 `EngineConfig.runtime` 放寬成 `Runtime`,
 * 對現有呼叫端是非破壞性的。目前沒有呼叫端需要,所以不先定那個聯合。
 */
export interface SpawnRuntime {
  name: string;
  capabilities: RuntimeCapabilities;
  /**
   * 還不能用在正式流程的 adapter,寫明原因。`createAgentEngine` 看到它會拒絕,除非宿主設了
   * `allowExperimentalRuntime` —— 一個「看起來成功」的壞 runtime 比直接失敗難查得多。
   */
  experimental?: string;
  command(ctx: CommandContext): SpawnCommand;
  /**
   * 這個 runtime 沒有原生工具時,manifest 宣告的 `capabilities` 要靠哪些 **gateway 工具**表達(tool id)。
   *
   * 例:裸模型沒有 Read / Grep / Glob,`filesystem: 'read-only'` 就換成 `fs-*` 這幾個唯讀檔案工具。
   * registry 載入時把它們併進該 agent 的允許清單並驗證存在 —— manifest 仍只寫**意圖**,不必為某個 runtime 改寫。
   * 省略 = 不補任何工具(claude 靠原生工具,用 `--tools` 表達)。
   */
  gatewayToolsFor?(capabilities: AgentCapabilities | undefined): string[];
  /** Serializable routes for capability tools supplied by this adapter. */
  gatewayToolDefinitionsFor?(capabilities: AgentCapabilities | undefined): ToolDecl[];
  /**
   * 這個 runtime 給不給得起 manifest 宣告的 `capabilities`;給不起就丟 `EngineError`。載入 agent 時(spawn 之前)呼叫。
   *
   * **只驗能力,不驗執行參數**。省略時 registry 退回「丟一個最小的 `command()` 進去看會不會 throw」—— 那對 claude / codex
   * 夠用,但 `command()` 還會驗模型、prompt 這類**每次執行才有**的參數(模型可以由 `TakeSpec.model` 提供),
   * 拿它做預檢,會把「這次還沒給模型」誤判成「這個 runtime 沒有這個能力」。runtime 有執行參數要驗時,實作這個方法把兩者分開。
   */
  validateCapabilities?(capabilities: AgentCapabilities | undefined): void;
  /**
   * 子程序失敗時,runtime 能從退出碼與 stderr 尾端看出什麼(值不值得重試、HTTP 狀態碼)。engine 把結果放進
   * `EngineError.retryable` / `.status`,上層直接用。省略 = 沒有意見(claude 的失敗訊息沒有穩定的格式可判)。
   */
  classifyFailure?(failure: { exitCode: number | null; stderr: string }): FailureClass | undefined;
  /**
   * 把子程序輸出翻成事件與文字。省略 = 整段 stdout 當輸出。
   * claude 的 `--output-format stream-json` 在這裡解(`runtimes/claudeStream.ts`);codex 的 `--json`
   * 還沒有 decoder,所以 `codexCli` 標為 experimental。
   */
  createDecoder?(): RuntimeDecoder;
}

/** 每個 take 建立一份,不得跨執行共用 JSONL 緩衝。finish 排空尾端並檢查截斷。 */
export interface RuntimeDecoder {
  push(chunk: string): RuntimeEvent[];
  finish(): RuntimeEvent[];
}

/** adapter 只回 runtime 事實;takeId、序號與最終狀態由 engine 補上。 */
export type RuntimeEvent =
  | { type: 'text'; chunk: string }
  | { type: 'output'; text: string } // 最終全文,不得再當 delta 追加
  | { type: 'plan'; entries: PlanEntry[] } // 取代整份計畫,不是追加
  | { type: 'tool-start'; toolCallId: string; toolId?: string; input?: unknown }
  | { type: 'tool-end'; toolCallId: string; toolId?: string; ok: boolean; elapsedMs: number; output?: unknown }
  | { type: 'usage'; mode: 'delta' | 'cumulative'; usage: Usage }
  | { type: 'stopped'; reason: StopReason };

/**
 * agent 自己宣布的執行計畫。**只是觀測,不是控制** —— engine 不依它做任何決定,
 * 宿主拿去顯示進度(bug Director 的 heartbeat 目前只能顯示 per-branch 狀態,
 * 有這個會豐富得多)。
 *
 * 借自 ACP 的 `plan` session update。
 */
export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * 這一輪為什麼停。**借自 ACP 的 stop reason**,不自己發明一套 —— 那套已經被
 * 幾十家 agent 實作過,而且比原本只分「正常/失敗」細。
 *
 * `max_tokens` / `max_turn_requests` 與逾時**是同一類事**:被預算砍斷,但可能
 * 已經產出有用的東西 —— 正是 salvage 的場景。所以它們一起映射到
 * `TakeStatus: 'truncated'`,不是 `error`。
 */
export type StopReason =
  /** 模型講完了,沒有再要工具。 */
  | 'end_turn'
  /** 觸到 token 上限。 */
  | 'max_tokens'
  /** 觸到單輪模型請求次數上限。 */
  | 'max_turn_requests'
  /**
   * 對話累積超過 context 預算:**輸入放不下**(工具結果越積越多),runner 在送出一個注定被模型端退回的請求之前收尾。
   * 跟 `max_tokens`(**輸出**被截斷)是不同的事 —— 前者要減少餵進去的東西,後者要放寬輸出上限;混在一起,
   * 重試與監控就判斷不出該動哪一邊。同樣是被預算砍斷、可能已有可用內容,所以歸在 `truncated`。
   */
  | 'context_exceeded'
  /**
   * 單回合思考超過預算、重來後仍然想太久:模型一路在思考、始終沒有文字或工具呼叫。跟 `max_tokens` 不同 ——
   * 那是輸出寫不完,這是**想不完**(處置也不同:調思考上限或換模型,不是調輸出上限)。同樣歸在 `truncated`。
   */
  | 'reasoning_budget'
  /**
   * 輸出超過 `maxOutputBytes`,由 engine 砍斷。跟逾時同類 —— 被預算砍斷,
   * 但已經吐出來的東西可能有用。
   */
  | 'max_output'
  /**
   * 額度用盡。**跟其他終止原因不同:它不值得 salvage,也不可重試** ——
   * 要等重置。對應 `EngineErrorKind: 'quota'`。
   */
  | 'quota'
  /** agent 拒絕繼續。 */
  | 'refusal'
  /** 被取消。 */
  | 'cancelled'
  /**
   * engine 的 wall-clock 預算到了。**由 engine 合成,不是 adapter 回報的** ——
   * agent 不知道宿主給了它多少時間。放在同一個列舉裡,`stopReason` 才是完整的。
   */
  | 'timeout'
  /** 子程序掛了、或 adapter 判斷不出來(未知的退出碼或格式)。 */
  | 'unknown';

// ─── 產物 ────────────────────────────────────────────────────────────────

/**
 * `scope` 讓一個 engine 服務多個並行工作 —— bug 是一個程序服務很多 thread,
 * 每個 thread 一個證據目錄。store 自己決定 scope 映射到哪。
 */
/** 正式產物的邏輯名稱,與實體檔案路徑無關。 */
export interface ArtifactKey {
  scope?: string;
  name: string;
}

/** 已提交的不可變版本;下游固定引用此 ref。 */
export interface ArtifactRef extends ArtifactKey {
  version: string;
}

/** partial 以 take 隔離,不使用 scope + name 共用緩衝。 */
export interface DraftRef {
  takeId: string;
}

export interface ArtifactStore {
  append(ref: DraftRef, chunk: string): Promise<void>;
  readPartial(ref: DraftRef): Promise<string | null>;
  /**
   * 成功解析/驗證後才提交。原子發布新版本,不覆寫舊版本。
   * 同一 draft 重複提交相同 key/content 必須回同一 ref;不同內容應拒絕。
   * 版本分配須支援 store 宣告範圍內的並行提交。
   */
  commit(draft: DraftRef, key: ArtifactKey, content: string): Promise<ArtifactRef>;
  /** 固定版本讀取;不存在回 null。 */
  read(ref: ArtifactRef): Promise<string | null>;
  /** 查最新已提交且未作廢的版本;宿主應取得 ref 後固定使用它。 */
  latest(key: ArtifactKey): Promise<ArtifactRef | null>;
  /** 宿主明確作廢某版本;保留內容供固定版本讀取與稽核。 */
  supersede(ref: ArtifactRef): Promise<void>;
  /**
   * take 沒成功(失敗、取消、被截斷)時丟掉它的 draft。選用:沒實作的 store 就留著 draft。
   * 不丟的話,每個沒成功的 take 都在 drafts/ 留一份永遠沒人收的串流。
   */
  discard?(draft: DraftRef): Promise<void>;
}

// ─── 事件 ────────────────────────────────────────────────────────────────

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/** engine 依每個 take 的接收順序編號,seq 嚴格遞增。 */
export interface EventMeta {
  takeId: string;
  seq: number;
  at: number;
}

/**
 * text 為解碼後的文字 delta,不做 UI 行緩衝,不是原始 JSONL bytes。
 * usage: delta 相加,cumulative 替換同一 take 的累計值;adapter 在 take 內不可切換模式。
 * completed 是唯一終態(含失敗/取消),在提交與有限期限清理後發出且只發一次。
 * 終態後不再發 take 事件或提交產物;晚到資料只進診斷 log。
 */
export type RunEvent = EventMeta & (
  | { type: 'started'; agent: string }
  | { type: 'text'; chunk: string }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'tool-start'; toolCallId: string; toolId?: string; input?: unknown }
  | { type: 'tool-end'; toolCallId: string; toolId?: string; ok: boolean; elapsedMs: number; output?: unknown }
  | { type: 'usage'; mode: 'delta' | 'cumulative'; usage: Usage }
  | { type: 'completed'; status: TakeStatus; stopReason: StopReason; elapsedMs: number;
      error?: EngineError; artifact?: ArtifactRef; cleanup: 'complete' | 'unconfirmed' }
);

// ─── 錯誤 ────────────────────────────────────────────────────────────────

/**
 * 依「宿主拿到之後要做什麼決定」切,不是依技術成因切。
 *
 * 被預算砍斷**不在這裡** —— 那是 `status: 'truncated'`,而且可能被 salvage
 * 救成 `ok`。
 */
export type EngineErrorKind =
  /** manifest 寫錯、工具 id 不存在。修設定,不重試。 */
  | 'config'
  /** 選定 runtime 給不起 manifest 要的能力。換 agent 或裝東西,不重試。 */
  | 'capability'
  /** 額度用盡。等重置,不重試。engine 看退出碼判定(實測 claude 用 88,見 engine.ts `QUOTA_EXIT_CODE`)。 */
  | 'quota'
  /** 子程序故障。可重試。 */
  | 'runtime'
  /**
   * 輸出不合宿主的 schema(`parseOutput` 丟出例外)。
   *
   * 跟 `runtime` 分開是因為處置不同:子程序故障重試通常有用,輸出格式不對
   * 重試前該先看看是不是 prompt 的硬規沒講清楚。
   */
  | 'output'
  /** 使用者取消。不算失敗。 */
  | 'cancelled';

/**
 * runtime 對一次失敗的判斷(`SpawnRuntime.classifyFailure`)。宿主直接讀 `EngineError` 上的這兩個欄位,
 * 不必自己去解析 stderr 或訊息 —— 那是 runtime 的傳輸細節,每個宿主各自解讀就會各有各的政策。
 */
export interface FailureClass {
  /** 同樣的請求再送一次有沒有可能成功。`undefined` = runtime 沒有意見(宿主照 `kind` 的預設處理)。 */
  retryable?: boolean;
  /** 模型端回的 HTTP 狀態碼(有的話)。給監控與日誌用。 */
  status?: number;
}

export class EngineError extends Error {
  /** runtime 判斷這次失敗值不值得重試。只有 runtime 看得懂失敗細節時才有(例如 vercel-ai 的 runner 會留標記)。 */
  readonly retryable?: boolean;
  /** 模型端的 HTTP 狀態碼(有的話)。 */
  readonly status?: number;

  constructor(
    readonly kind: EngineErrorKind,
    message: string,
    readonly cause?: unknown,
    failure?: FailureClass,
  ) {
    super(message);
    this.name = 'EngineError';
    if (failure?.retryable !== undefined) this.retryable = failure.retryable;
    if (failure?.status !== undefined) this.status = failure.status;
  }
}

// ─── Take ────────────────────────────────────────────────────────────────

/**
 * engine 產生四種執行終態。判準是**宿主拿到之後要做什麼**:
 *
 * | 狀態 | 宿主的處置 |
 * |---|---|
 * | `ok` | 用結果 |
 * | `truncated` | 被預算砍斷,**試著 salvage**;救不回才當失敗 |
 * | `error` | 這一路失敗,降級整合 |
 * | `cancelled` | 不算失敗 |
 *
 * **`truncated` 取代原本的 `timeout`。** 逾時、`max_tokens`、
 * `max_turn_requests` 是同一類事 —— 被預算砍斷,但可能已經產出有用的東西,
 * 宿主的處置也完全相同。只列 `timeout` 會漏掉另外兩種(那是接上 ACP 的
 * stop reason 之後才看見的)。實際是哪一種看 `stopReason`。
 *
 * **`skipped` 不在這裡** —— 它是宿主路由的決定(「這個 angle 這輪不用查」),
 * engine 沒有立場產生它。宿主要那一態自己加。
 */
export type TakeStatus = 'ok' | 'truncated' | 'error' | 'cancelled';

export interface TakeSpec {
  /** Agent definition; validated before spawning. IDs identify records, not lookup targets. */
  agent: AgentDefinition;
  /** **已經組好的** prompt。engine 不拼 prompt。 */
  prompt: string;
  /** 產物歸屬。省略 = store 的預設位置。 */
  scope?: string;
  signal?: AbortSignal;
  /**
   * 只收這次 take 的事件,在 `EngineConfig.onEvent` 之後同步呼叫。
   *
   * 同一個 engine 服務很多並行請求時,每個請求要把進度送到自己的地方(自己的 Slack thread、
   * 自己的 heartbeat),不能靠 engine 層的 callback 再依 takeId 分派。
   *
   * **同步、不等待**:回傳的 promise 不會被 await。宿主的 callback 若要做慢事(打 Slack API),
   * 自己排隊 —— engine 不能讓一個卡住的 callback 拖住串流、或讓 take 永遠收不了尾。
   */
  onEvent?: (event: RunEvent) => void;
  /**
   * 這次 take 的 gateway `${VAR}` 插值,疊在 `EngineConfig.env` 之上(同名以這裡為準)。
   *
   * 給「每次 take 內容不同」的值用,例如預抓好的 Jira 單路徑。跟 `EngineConfig.env` 一樣
   * **只給 gateway,不進 CLI 子程序的環境**。
   */
  env?: Record<string, string | undefined>;
  /**
   * 整個 take 的 wall-clock 上限,**涵蓋 engine 內部做的任何事**。
   * 省略 = 用 `EngineConfig.defaults.timeoutMs`;兩者皆無 = 無上限。
   */
  timeoutMs?: number;
  model?: string;
  /**
   * 輸出上限(位元組)。超過就砍斷子程序,終態是 `truncated` / `max_output`。
   * 省略 = 用 `EngineConfig.defaults.maxOutputBytes`;兩者皆無 = 無上限。
   *
   * 沒有它的話,一個跑偏的 agent 會把無上限的文字吃進記憶體並寫進產物。
   */
  maxOutputBytes?: number;
  /** 計時起點。呼叫端在 take 之前還做了別的事(探測、fast-path)時傳,秒數要誠實。 */
  startedAt?: number;
  /** 把原始輸出翻成 `output`。省略 = 原文照回。**輸出 schema 是業務的。** */
  parseOutput?: (raw: string) => string;
  /**
   * 被預算砍斷時(`truncated`)判斷 partial 救不救得回。回 null = 救不回。
   * 省略 = 不救。逾時、`max_tokens`、`max_turn_requests` 都會走到這裡。
   */
  salvage?: (raw: string) => string | null;
}

export interface TakeResult {
  takeId: string;
  /** manifest 的 `reportAs` ?? `id`。產物檔名與宿主看到的分支名共用它。 */
  name: string;
  agent: string;
  status: TakeStatus;
  /** `parseOutput` 之後的結果。 */
  output: string;
  /** 未經解析的原始輸出。 */
  raw: string;
  elapsedMs: number;
  /** 整個 take 的累計用量。 */
  usage?: Usage;
  /** 僅成功 commit 後提供。 */
  artifact?: ArtifactRef;
  /** 清理期限內未確認完成時不可宣稱資源已停止。 */
  cleanup: 'complete' | 'unconfirmed';
  error?: EngineError;
  /** 這一輪為什麼停。`status` 是粗分類,這個是原因。 */
  stopReason: StopReason;
  /** 被預算砍斷但被 `salvage` 救回時為 true(此時 `status` 是 `ok`)。 */
  salvaged?: boolean;
}

// ─── Engine ──────────────────────────────────────────────────────────────

export interface SkillAvailability {
  available: boolean;
  /** `available: true` 時為空字串。 */
  reason: string;
}

export interface EngineConfig {
  /** `manifests/` 在哪。省略 = `AGENT_ENGINE_ROOT` ?? cwd。建議明寫。 */
  root?: string;
  /**
   * 這個 engine 只准用這幾個 agent(其他 id 的 take 直接拒絕)。省略 = `manifests/` 裡的
   * 任何 agent 都能用。
   *
   * 不影響故障隔離 —— agent 本來就是各自延遲載入,壞掉的 manifest 只影響它自己。
   * 它決定的是 `check()` 驗哪些:有設 = 只驗這幾個;省略 = 全量。
   */
  agentIds?: string[];
  /** 不想寫檔的 agent 宣告。與 `manifests/` 合併,id 衝突時 fail loud。 */
  agents?: AgentDefinition[];
  /**
   * 執行方式。省略 = claude CLI。
   *
   * 只支援子程序家族(見 `SpawnRuntime`;裸模型也是,它 spawn 的是自己的 runner)。
   * 若日後需要 engine 層級的迴圈,這裡會放寬成 `SpawnRuntime | LoopRuntime`,對現有呼叫端非破壞性。
   */
  runtime?: SpawnRuntime;
  /** 允許 `experimental` 的 runtime(開發 adapter 本身時才用)。省略 = 拒絕。 */
  allowExperimentalRuntime?: boolean;
  /**
   * **目前不支援,傳了會在 `createAgentEngine()` 當場丟 `EngineError('config')`。**
   *
   * gateway 是 `claude -p` 以 stdio 拉起的另一個程序,收不到宿主的 JS 物件,所以
   * 這裡注入的實作到不了模型手上。宿主的工具請做成 stdio MCP server,在
   * `manifests/mcp-servers/` 宣告成一般上游(見 mcp-hub 的 `createBuiltinServer`)。
   * 欄位保留是為了之後的 in-process runtime。
   */
  builtinTools?: BuiltinTool[];
  /** 產物落盤。省略 = 預設 store。 */
  artifacts?: ArtifactStore;
  /** skill 預檢。省略 = 內建實作(讀 claude 的 `installed_plugins.json`)。 */
  checkSkill?: (plugin: string) => SkillAvailability;
  /** 事件接收。省略 = 不發。 */
  onEvent?: (event: RunEvent) => void;
  /**
   * gateway 的 manifest `${VAR}` 插值取值來源,疊在 `process.env` 之上(例如這個 engine 要連哪台
   * playwright proxy)。**只給 gateway,不進 CLI 子程序的環境** —— 子程序本來就繼承 process.env,
   * 而這裡常放的是只有工具才該拿到的值。
   */
  env?: Record<string, string | undefined>;
  /** 每次 take 的預設值,`TakeSpec` 可覆寫。 */
  defaults?: { timeoutMs?: number; model?: string; maxOutputBytes?: number };
  /** 稽核 log。預設寫 stderr。 */
  log?: (line: string) => void;
}

/**
 * **建立時不做任何 IO**:manifest 在每個 agent 第一次 `runTake` 時才載入並驗證,所以宿主
 * 可以在 module 頂層 `export const engine = createAgentEngine(...)`,import 沒有副作用。
 * 一份 manifest 壞掉只讓那個 agent 的 take 被拒(`EngineError` config / capability,
 * 在 spawn 之前),同一個 engine 上的其他 agent 照常。
 */
export interface Engine {
  /** agent 的 manifest 載入或驗證失敗 → reject `EngineError`(不發事件、不 spawn),修好檔案下次會重試。 */
  runTake(spec: TakeSpec): Promise<TakeResult>;
  /**
   * 立刻載入並驗證全部 agent(有 `agentIds` 就只驗那幾個),失敗丟 `EngineError`。
   * 給宿主在 boot 時 fail fast;回傳驗過的 agent id。
   */
  check(): string[];
  /** 等待所有子程序與上游連線清理完成。有限的關閉期限。關閉後 `runTake` 一律拒絕。 */
  close(): Promise<void>;
}
