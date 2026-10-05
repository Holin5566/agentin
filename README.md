# Agentin

**The right agent for every step.**

Agentin 是開發中的 TypeScript 開源 SDK，讓開發者在多步驟 SOP 中，依任務需求配置不同 agent、模型、runtime 與工具，透過一致的介面執行任務並取得結果。

一段流程中的資料擷取、分類、推理與程式修改，往往需要不同能力。Agentin 的目標是降低混用這些能力的整合成本：讓專門模型處理例行工作，讓強模型處理關鍵判斷，並集中處理事件、工具接入、取消、逾時與程序清理。

## 為什麼使用 Agentin

如果流程只呼叫一個模型，直接使用原本的 SDK 通常就足夠。當應用需要混用模型 API、CLI agent 與 MCP 工具，而且持續調整各步驟配置時，Agentin 提供共用的執行契約，減少重複接線。

- **按步驟選擇 agent**：角色指示、runtime 與工具範圍分別配置；單次執行可以覆寫 runtime 與模型。
- **共用執行管理**：統一取得事件、結果、usage 與產物，處理取消、逾時和清理。
- **接入應用工具**：透過函式工具與 MCP，把既有業務能力提供給指定 agent。
- **保留取捨空間**：由宿主程式決定順序、平行處理、結果驗證與失敗升級，依實際表現調整模型配置。

模型配置是否省成本、token 或時間，取決於工作量、硬體、結果品質與重試次數，需要實測。Agentin 提供執行與整合基礎；目前沒有自動模型路由、成本計價或流程最佳化功能。

## 使用情境：混合模型的 SOP

例如處理一批圖片，可以將工作拆成：

| 步驟 | 執行方式 | 交接內容 |
|---|---|---|
| 擷取圖片欄位 | 地端專門視覺模型 | 所需欄位與辨識結果 |
| 驗證格式與完整度 | 一般程式 | 合格資料或待處理問題 |
| 分析例外 | 強模型 agent | 判斷與處理建議 |
| 修改處理程式 | coding agent runtime | 修改結果與驗證證據 |

這是目標使用情境，並非目前已完成的讀圖範例。現有 `run.input` 是文字；圖片輸入、多模態交接與結構化驗收仍需另外設計。宿主現在可以用一般 TypeScript 程式碼串接文字任務，不需要先採用一套工作流 DSL。

## 專案狀態

目前是開發中的 alpha，尚未發布 npm。`agent-engine/` 與 `mcp-hub/` 直接嵌在 repo 根目錄，以 private package 管理本機相依與建置。

| 能力 | 目前狀態 |
|---|---|
| Agent 定義與派發 | 已提供 `defineAgent()`、`createAgentin()`、`run()`、`close()` |
| Runtime | 已有 Claude CLI、OpenCode、Vercel AI adapter |
| 工具 | 已有 MCP 路由、允許清單、schema 驗證與 `defineTool()` 函式橋接 |
| 執行管理 | 已有事件、取消、逾時、錯誤分類、輸出解析與產物 |
| 範例 | 已有本機 echo、單次 CLI 問答與模型 API 問答 |
| SOP 編排 | 由宿主程式串接；尚無內建 workflow、交接驗證或自動升級 |
| 對話與多模態 | 尚無 session 管理或公開圖片輸入介面 |
| 對外交付 | 乾淨安裝、來源授權與真實 runtime 驗收仍待完成 |

測試包含模擬模型端點、替代 CLI 程序與真正跨程序的 MCP 呼叫。這些驗證涵蓋 SDK 與底層契約，不代表真實模型的品質或所有 CLI 權限行為已完成驗收。最新結果以 `npm run check` 為準。

## 底層開發

需要 Node.js 20 以上，在 repo 根目錄執行：

```sh
npm run setup
npm run build
npm test
npm run smoke
```

測試使用本機假模型，不需模型帳號；環境需允許本機 HTTP 與子程序操作。`npm run smoke` 執行 SDK 公開介面範例，`npm run test:sdk` 執行 SDK 型別與整合驗證。

底層用法：[Engine](agent-engine/README.md)、[Hub](mcp-hub/README.md)。來源與授權：[來源紀錄](docs/provenance.md)。此副本尚未執行真實模型 CLI 驗證。

## 第一版範圍

第一版聚焦於可被宿主流程組合的單步 agent 執行：角色與工具宣告、runtime 選擇、事件、取消、逾時、結果與清理。

接下來優先驗證真實 runtime、完成終端聊天與多步驟 SOP 範例，並收斂公開 API。結構化交接、資源比較、圖片輸入與 session 依實際範例需求評估。瀏覽器探索及 Playwright 腳本生成由範例或宿主流程實作。

## 使用方式

```ts
import { defineAgent, createAgentin, claudeRuntime } from 'agentin';

const assistant = defineAgent({
  id: 'assistant',
  instructions: '用繁體中文協助使用者，查資料時使用指定工具。',
  tools: [],
});

const agentin = createAgentin({
  agents: [assistant],
  runtimes: {
    claude: claudeRuntime(),
  },
  defaultRuntime: 'claude',
});

try {
  const result = await agentin.run({
    agent: 'assistant',
    input: '解釋這個專案的用途',
    runtime: 'claude',
  });
  console.log(result.status, result.output);
} finally {
  await agentin.close();
}
```

範例需放在 async 函式內執行。本機使用 `require('./dist')`，尚未發布 npm；上面的套件 import 適用於本機相依整合。可執行範例見 [examples/basic.cjs](examples/basic.cjs)：`npm run smoke` 使用本機 echo runtime；明確執行 `node examples/basic.cjs --claude` 才會使用已安裝並授權的 Claude CLI。

Agent 是角色與能力宣告；runtime 是執行方式。切換 runtime 前須驗證能力相容，不承諾不同執行器行為完全相同。runtime 選擇順序為單次 `run.runtime` → agent 的 `runtime` → `defaultRuntime`。SDK 的原生檔案與 shell 權限預設關閉，必須用 `capabilities` 明確開啟。工具接受 SDK `defineTool()` 的宿主函式、Hub 路由物件或 ID。

`run()` 支援 `signal`、`onEvent`、`timeoutMs`、`model`、`maxOutputBytes` 與 `parseOutput`。結果包含 runtime 名稱以及 Engine 的狀態、stopReason、usage、產物與 cleanup。設定錯誤 reject `EngineError`；執行與能力失敗依結果模型回報。`close()` 取消所有進行中的工作，重複呼叫回同一份關閉 Promise。

需要結構化結果時傳入 Zod 4 schema 作為 `output`：

```ts
const verdict = z.strictObject({ pass: z.boolean(), reason: z.string() });
const result = await app.run({ agent: 'judge', input: '請以 JSON 回覆 {"pass": boolean, "reason": string}', output: verdict });
if (result.status === 'ok') console.log(result.data!.pass);
```

SDK 依序嘗試整段輸出與文字中每個平衡的 JSON object／array，取第一個通過 schema 的值；前後說明文字與 code fence 會被略過。`result.data` 為解析後型別，`result.output` 與產物保存相符的 JSON 原文。有 `parseOutput` 時先套用它再驗證。不符合時 take 以 `output` 錯誤結束，不產生產物或 `data`，也不自動重跑。SDK 不改寫 prompt，輸出格式須由 instructions 或 input 說明。驗證為同步執行，非同步 refinement 會使驗證失敗。

Session 留到最後再評估是否加入；Terminal UI 由宿主負責。

## 宿主函式工具

```ts
import { defineTool, defineAgent } from 'agentin';
import { z } from 'zod/v4';

const greet = defineTool({
  id: 'greet',
  description: '向使用者打招呼',
  inputSchema: z.strictObject({
    name: z.string().min(1).describe('要打招呼的對象姓名'),
  }),
  execute: async ({ name }, { signal, agent, runId }) => {
    signal.throwIfAborted();
    return `你好，${name}！`;
  },
});
const assistant = defineAgent({ id: 'assistant', instructions: '使用 greet 工具。', tools: [greet] });
```

`inputSchema` 接受 Zod 4（`zod/v4`）或原本的 JSON Schema。Zod 寫法會自動推導 `execute` 的參數為解析後型別，並在宿主執行前套用預設值、轉換與非同步 refinement。SDK 使用 [Zod JSON Schema 轉換](https://zod.dev/json-schema)的輸入模式產生 draft-7 schema；schema 必須能描述 object 輸入，無法轉換的型別會在 `defineTool()` 時拒絕。JSON Schema 寫法的參數型別維持 `Record<string, unknown>`。

函式與 closure 留在宿主；每次 run 開啟獨立憑證的 loopback HTTP 端點，經 stdio MCP proxy 與 Hub 允許清單接入 runtime。參數在執行前按 JSON Schema 驗證，支援文字或完整 MCP CallToolResult。已知工具失敗可 throw `ToolFailure`，取消由 `context.signal` 傳遞；忽略 signal 的宿主函式仍可能繼續執行。

`context.agent` 是 agent ID；`context.runId` 是 SDK 橋接 ID，與 Engine takeId 不同。任務結束或 SDK close 時撤銷端點；憑證不放 argv，臨時連線設定檔限制存取並隨任務移除。JSON 參數大小上限為 1 MiB。

可與外部 MCP 工具混用，且不會修改宿主 manifests。範例見 [examples/function-tool.cjs](examples/function-tool.cjs)。真實 Claude／OpenCode 的函式橋接仍待已安裝、授權環境驗證；無模型測試已覆蓋 AI runner 與 Hub 的實際跨程序路徑。

## Claude CLI 與 OpenCode runtime

```ts
import { claudeRuntime, opencodeRuntime } from 'agentin';

const runtimes = {
  claude: claudeRuntime(),
  opencode: opencodeRuntime({ model: 'provider/model' }),
};
// createAgentin({ agents, runtimes, defaultRuntime: 'claude' })
// run({ agent: 'assistant', input: '...', runtime: 'opencode' })
```

兩者需先在宿主安裝並完成模型授權。`executable` 可指定 CLI 路徑，`env`／`unsetEnv` 控制子程序環境；每次 run 開新任務，不接續隱藏 session。

Claude 使用 `-p --output-format stream-json`，透過 strict MCP config 與原生工具名單限制工具。OpenCode 使用 `run --format json`，為每次任務建立獨立 primary agent，預設 deny，再開啟指定原生工具及 Hub 工具。OpenCode 的 MCP 轉換與事件格式依 [官方 CLI 原始碼](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/cli/cmd/run.ts) 與 [權限規範](https://opencode.ai/docs/permissions/) 實作。

OpenCode 關閉專案設定載入，但仍可能載入受信任的全域／組織設定與 plugins；這不是 CLI 設定或 OS 程序沙箱。它拒絕 `workspace-write`，因為目前無法兌現工作目錄寫入隔離。其 tool-start／tool-end 在 CLI 回報完成時一併發出，不能當作即時開始通知。

驗證包含假 CLI 的 SDK 接線與串流／權限契約測試。Claude 本機 help 已確認所用旗標；此環境沒有 OpenCode binary，尚未執行兩個 CLI 的真實模型驗證。

可執行範例：[examples/cli.cjs](examples/cli.cjs)，明確執行 `node examples/cli.cjs claude` 或 `node examples/cli.cjs opencode` 才呼叫真實 CLI；可用 `AGENTIN_MODEL` 指定模型。

## Vercel AI runtime

`vercelAiRuntime()` 沿用 Engine 的 AI SDK runner，由子程序執行模型與 tool loop，同樣支援事件、取消、逾時與產物。

```ts
import { vercelAiRuntime } from 'agentin';

const runtime = vercelAiRuntime({
  provider: 'openai-compat',
  baseUrl: 'http://localhost:11434/v1',
  model: 'your-model',
  apiKey: process.env.AGENTIN_API_KEY,
});
// 放進 createAgentin({ runtimes: { ai: runtime }, defaultRuntime: 'ai', ... })
```

也支援 `provider: 'anthropic'`，可省略 baseUrl 使用官方端點。`run.model` 覆寫 runtime 預設模型。可設定 `maxSteps`、`maxTokens`、工具結果與 context 預算；金鑰透過子程序環境傳入，不放 argv。

沒有原生 shell／寫檔工具或 Claude skills，要求這些能力會在 spawn 前拒絕。唯讀檔案能力透過 Hub 的 `fs-readonly` server 提供，需由宿主配置該 server。模型端工具結果目前以文字回灌。

可執行範例：[examples/vercel-ai.cjs](examples/vercel-ai.cjs)。設定 `AGENTIN_MODEL`、`AGENTIN_BASE_URL`，視 provider 設定 `AGENTIN_API_KEY`／`AGENTIN_PROVIDER`，再執行 `node examples/vercel-ai.cjs`；這會實際呼叫設定的模型服務。

## 目錄與責任

```text
agentin/
├── src/                         SDK 對外整合層
│   ├── agentin.ts               註冊、派發、生命週期
│   ├── agent.ts                 純 Agent 定義
│   ├── runtimes/                runtime adapter 與能力映射的整合
│   ├── tools/                   函式工具、MCP 引用與宿主橋接
│   ├── sessions/                保留目錄：對話管理待評估
│   └── index.ts                 公開 API
├── agent-engine/                一次 take 的執行與結果管理
├── mcp-hub/                     工具允許清單、路由與上游連線
├── examples/
│   ├── basic.cjs                本機 echo／Claude 單次執行
│   ├── cli.cjs                  Claude／OpenCode 單次執行
│   ├── vercel-ai.cjs            模型 API 單次執行
│   ├── terminal-chat/           規劃：自己的 Terminal 聊天
│   └── browser-explorer/        規劃：瀏覽器探索與證據
├── tests/integration/           SDK 與底層整合驗證
├── scripts/                     後續的驗證／交付腳本
├── docs/
│   ├── architecture.md          分工與執行契約
│   └── roadmap.md               範圍、順序與完成條件
└── README.md
```

SDK 公開入口、函式工具橋接與單次執行範例已實作；session 與產品範例尚未實作。Engine／Hub 已有實際程式與模組測試。Engine 的 adapter 實作歸 Engine；`src/runtimes/` 負責對外設定與註冊，避免重複維護兩套 adapter。

## 架構

```text
Terminal／Web／業務服務
            ↓
     Agentin 公開 API
            ↓
       Agent Engine
      ├── Claude CLI
      ├── OpenCode
      └── Vercel AI runner
            ↓ 工具接入依 adapter 能力驗證
         MCP Hub
            ↓
   外部 MCP／宿主函式橋接
```

MCP Hub 的工具邊界必須由 adapter 真正接入執行器並驗證；不能只在 prompt 中限制。執行器的原生工具需要各自的能力與權限映射。

## 設計原則

- 保留各 runtime 差異與能力檢查，提供共通契約及必要擴充入口。
- 明確區分執行成功、輸出合格與業務驗收成功。
- Fallback 預設關閉；已產生副作用的任務不得因一般錯誤自動重播。
- 不隱含共用對話；資源所有權、取消限制與清理結果需明確。
- SOP 編排、步驟交接、平台登入與業務驗收由宿主負責；需要重試或升級時由宿主明確決定。

參考設計來自 Guardian 的執行管理與 JackIn 的函式工具接入。公開程式前須確認來源授權與可公開範圍；範例使用通用資料，不含公司憑證、內部網址或業務紀錄。授權與貢獻規範待公開前確認。

完整說明：[架構與責任](docs/architecture.md)、[開發路線](docs/roadmap.md)。
