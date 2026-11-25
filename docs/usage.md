# API 與 runtime 詳細說明

從 [README Quick Start](../README.md#quick-start) 開始；本頁整理進階設定與執行限制。

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

範例需放在 async 函式內執行。本機使用 `require('./dist')`，尚未發布 npm；上面的套件 import 適用於本機相依整合。可執行範例見 [examples/basic.cjs](../examples/basic.cjs)：`npm run smoke` 使用本機 echo runtime；明確執行 `node examples/basic.cjs --claude` 才會使用已安裝並授權的 Claude CLI。

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

可與外部 MCP 工具混用，且不會修改宿主 manifests。範例見 [examples/function-tool.cjs](../examples/function-tool.cjs)。真實 Claude／OpenCode 的函式橋接仍待已安裝、授權環境驗證；無模型測試已覆蓋 AI runner 與 Hub 的實際跨程序路徑。

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

可執行範例：[examples/cli.cjs](../examples/cli.cjs)，明確執行 `node examples/cli.cjs claude` 或 `node examples/cli.cjs opencode` 才呼叫真實 CLI；可用 `AGENTIN_MODEL` 指定模型。

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

可執行範例：[examples/vercel-ai.cjs](../examples/vercel-ai.cjs)。設定 `AGENTIN_MODEL`、`AGENTIN_BASE_URL`，視 provider 設定 `AGENTIN_API_KEY`／`AGENTIN_PROVIDER`，再執行 `node examples/vercel-ai.cjs`；這會實際呼叫設定的模型服務。

