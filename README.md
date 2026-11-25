# Agentin

Agentin 是 TypeScript Agent SDK。用結構化領域知識決定查詢目標，透過各 agent 的工具範圍執行任務。

| 核心能力 | 工程責任 |
|---|---|
| **Agent Engine** | 在可替換的 runtime 執行任務，提供事件、逾時、取消與資源清理。 |
| **Scoped MCP Hub** | 依 agent 的允許清單暴露工具，驗證輸入並轉送 MCP 呼叫。 |
| **Domain Ontology** | 分離使用者別名與實體，依查詢路徑推導目標。多候選且無法由預設值唯一決定時，回傳澄清選項。 |

## Quick Start

需要 Node.js 20 以上。目前尚未發布 npm，先從 repo 安裝。

### 1. 下載專案

取得原始碼，並切換到專案根目錄：

```sh
git clone https://github.com/Holin5566/agentin.git
cd agentin
```

### 2. 安裝相依套件

一次安裝 SDK、Agent Engine 與 MCP Hub 所需的套件：

```sh
npm run setup
```

### 3. 確認本機可以執行

建置 SDK 並執行 echo 範例，確認基本執行流程正常。這一步不需要模型帳號；echo 會回傳輸入文字。

```sh
npm run smoke
npm run smoke:ontology
```

Ontology 範例以同一個別名 `Alpha` 路由至付款服務。保留群組預設值時命中 `payment-service-a`，移除預設值後回傳兩個候選，等待明確選擇。

### 4. 試跑真實模型

先在本機安裝並授權 Claude CLI，再執行相同範例的 Claude 模式：

```sh
node examples/basic.cjs --claude
```

## 建立第一個 agent

在 repo 根目錄建立 `quick-start.ts`。以下逐步組合一個使用 Claude CLI 的 agent；最後提供完整程式與 TypeScript 執行方式。

### 1. 載入 SDK

從剛才建置的 `dist` 載入三個入口：`defineAgent` 定義角色，`claudeRuntime` 選擇執行方式，`createAgentin` 管理執行與資源。

```ts
import { defineAgent, createAgentin, claudeRuntime } from './dist';
```

### 2. 定義 agent 的角色

`id` 是執行時指定的名稱，`instructions` 告訴模型如何回答，`tools` 列出提供給 agent 的工具。這裡先建立純文字問答的角色。

```ts
const assistant = defineAgent({
  id: 'assistant',
  instructions: '用繁體中文簡短回答。',
  tools: [],
});
```

### 3. 註冊 agent 與 runtime

把角色交給 `createAgentin()`，並將 Claude CLI 註冊為 `claude`。`defaultRuntime` 決定沒有另外指定 runtime 時使用哪個執行器；此時尚未呼叫模型。

```ts
const app = createAgentin({
  agents: [assistant],
  runtimes: { claude: claudeRuntime() },
  defaultRuntime: 'claude',
});
```

### 4. 執行任務並讀取結果

`agent` 對應剛才的 `id`，`input` 是這次的任務，`timeoutMs` 將執行時間限制為 30 秒。等待完成後，從 `status` 判斷結果，再讀取 `output`。

```ts
const result = await app.run({
  agent: 'assistant',
  input: '解釋 SDK 的用途',
  timeoutMs: 30000,
});
console.log(result.status, result.output);
if (result.status !== 'ok') process.exitCode = 1;
```

這段使用 `await`，需放在下方完整範例的 `async main()` 中。

### 5. 關閉並清理資源

執行結束後呼叫 `close()`。放在 `finally`，可確保任務成功或拋出錯誤時都會清理資源；關閉也會取消仍在執行的任務。

```ts
try {
  // 放入上一步的 app.run() 與結果處理。
} finally {
  await app.close();
}
```

### 完整程式

把以上步驟組合成 `quick-start.ts`。`main().catch()` 處理設定或其他拋出的錯誤，並以非零結束碼表示失敗。

```ts
import { defineAgent, createAgentin, claudeRuntime } from './dist';

async function main() {
  const assistant = defineAgent({
    id: 'assistant',
    instructions: '用繁體中文簡短回答。',
    tools: [],
  });

  const app = createAgentin({
    agents: [assistant],
    runtimes: { claude: claudeRuntime() },
    defaultRuntime: 'claude',
  });

  try {
    const result = await app.run({
      agent: 'assistant',
      input: '解釋 SDK 的用途',
      timeoutMs: 30000,
    });
    console.log(result.status, result.output);
    if (result.status !== 'ok') process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

安裝 `tsx`，讓 Node.js 可以執行 TypeScript 範例：

```sh
npm install --save-dev tsx
```

在 repo 根目錄執行，開始呼叫 Claude CLI：

```sh
npx tsx quick-start.ts
```

## 基本用法

`defineAgent()` 定義角色與工具，`createAgentin()` 註冊 agent 和 runtime，`app.run()` 執行一次任務。完成後用 `app.close()` 清理資源。

下方片段沿用上面的 `app`，放在 `main()` 的 `try` 區塊內；新增工具或 runtime 時，先調整 `createAgentin()` 的設定。

### 取得結果與進度

```ts
const result = await app.run({
  agent: 'assistant',
  input: '列出三個 TypeScript 的優點',
  timeoutMs: 30000,
  onEvent: event => console.log(event),
});

if (result.status === 'ok') {
  console.log(result.output);
} else {
  console.error(result.error ?? result.stopReason);
}
```

`result` 也包含 `usage`、產物與清理結果。設定錯誤會拋出 `EngineError`；執行失敗應檢查 `result.status`。每次 `run()` 是獨立任務，目前不會自動延續對話。

### 取消任務

```ts
const controller = new AbortController();
const pending = app.run({
  agent: 'assistant',
  input: '分析這份資料',
  signal: controller.signal,
});

// 在停止按鈕或其他取消操作中呼叫。
controller.abort();
const result = await pending;
```

## 加入自己的工具

用 `defineTool()` 把宿主函式提供給 agent。以下定義可取代第一個範例的 agent；`createAgentin()` 的 `agents` 改成 `[assistant]`。

```ts
import { defineTool } from './dist';
import { z } from 'zod/v4';

const greet = defineTool({
  id: 'greet',
  description: '向指定姓名打招呼',
  inputSchema: z.strictObject({
    name: z.string().min(1),
  }),
  execute: async ({ name }, { signal }) => {
    signal.throwIfAborted();
    return `你好，${name}！`;
  },
});

const assistant = defineAgent({
  id: 'assistant',
  instructions: '使用 greet 工具向使用者打招呼。',
  tools: [greet],
});
```

再執行 `app.run({ agent: 'assistant', input: '請向 Liam 打招呼' })`。

工具參數會在執行前驗證。`inputSchema` 支援 Zod 4 或 JSON Schema，工具可回傳文字或完整 MCP 結果，也能與外部 MCP 工具混用。可執行範例見 [function-tool.cjs](examples/function-tool.cjs)；橋接與錯誤處理詳見 [工具說明](docs/usage.md#宿主函式工具)。

## Domain Ontology 與查詢路由

在 repo 根目錄使用範例圖。SDK 會先驗證關係的端點類型、基數、預設值與路徑，建立可重複使用的 resolver。

```js
const { createOntology, createOntologyTool, defineAgent } = require('./dist');
const ontology = createOntology(require('./examples/ontology-graph.json'));

const plan = ontology.resolve({
  route: 'group-payment',
  source: { label: 'Alpha' },
});
// resolved: alpha-group → shop-a → payment-service-a

const assistant = defineAgent({
  id: 'service-assistant',
  instructions: 'Use ontology_resolve. Ask the user to choose when clarification is returned.',
  tools: [createOntologyTool(ontology)],
});
```

將 `assistant` 加入 `createAgentin({ agents, runtimes, defaultRuntime })`，`ontology_resolve` 就會透過現有的 Scoped MCP Hub 出現在這個 agent 的工具清單。宿主也可直接呼叫 `ontology.resolve()`，以 `clarification` 暫停流程並展示候選。下一次查詢用使用者確認的 `source.entityId` 或 `targetId` 繼續。對有權限要求的操作，宿主應固定意圖路由、使用符合呼叫者授權的圖，並在派送前核對目標權限。

[圖結構、預設值規則與權限邊界](docs/architecture.md#domain-ontology)

## 取得結構化結果

在 `run()` 傳入 Zod schema，成功時從 `result.data` 取得驗證後的資料：

```ts
import { z } from 'zod/v4';
const verdict = z.strictObject({
  pass: z.boolean(),
  reason: z.string(),
});

const result = await app.run({
  agent: 'assistant',
  input: '判斷 2 + 2 = 4 是否正確。以 JSON 回覆 {"pass": boolean, "reason": string}。',
  output: verdict,
});

if (result.status === 'ok') console.log(result.data);
else console.error(result.error ?? result.stopReason);
```

請在指示中說明輸出格式。SDK 能從說明文字或 code fence 中找出符合 schema 的 JSON；驗證失敗會回報 `output` 錯誤，不會自動重跑。輸出 schema 使用同步驗證。

## 切換 runtime 與模型

同一個 agent 可以使用不同 runtime。在第一個範例的 `createAgentin()` 中註冊：

```ts
import { opencodeRuntime, vercelAiRuntime } from './dist';

const runtimes = {
  claude: claudeRuntime(),
  opencode: opencodeRuntime({ model: 'provider/model' }),
  ai: vercelAiRuntime({
    provider: 'openai-compat',
    baseUrl: 'http://localhost:11434/v1',
    model: 'your-model',
    apiKey: process.env.AGENTIN_API_KEY,
  }),
};
// createAgentin({ agents: [assistant], runtimes, defaultRuntime: 'claude' })
```

執行時指定已註冊的名稱，也可以覆寫模型：

```ts
const result = await app.run({
  agent: 'assistant',
  input: '解釋 SDK 的用途',
  runtime: 'opencode',
  model: 'provider/model',
});
```

Runtime 選擇順序是 `run.runtime` → agent 的 `runtime` → `defaultRuntime`。

| Runtime | 事前準備 | 可執行範例 |
|---|---|---|
| Claude CLI | 安裝並授權 Claude CLI | `node examples/cli.cjs claude` |
| OpenCode | 安裝 OpenCode 並設定模型 provider | `node examples/cli.cjs opencode` |
| Vercel AI | 準備模型 API 端點與模型名稱 | [vercel-ai.cjs](examples/vercel-ai.cjs) |

Vercel AI 範例使用 `AGENTIN_MODEL`、`AGENTIN_BASE_URL`，並依 provider 設定 `AGENTIN_API_KEY`／`AGENTIN_PROVIDER`。也支援 `provider: 'anthropic'`。

### 檔案與 shell 能力

原生檔案與 shell 工具預設關閉。需要讀檔時，在 agent 明確宣告：

```ts
const reader = defineAgent({
  id: 'reader',
  instructions: '閱讀檔案並整理摘要。',
  capabilities: { filesystem: 'read-only' },
  tools: [],
});
```

各 runtime 支援的能力不同：OpenCode 目前拒絕 `workspace-write`；Vercel AI 沒有原生 shell／寫檔工具，唯讀檔案需配置 Hub 的 `fs-readonly` server。工具名單限制不等於 OS 沙箱。詳見 [runtime 設定與限制](docs/usage.md#claude-cli-與-opencode-runtime)。

## 串接多步驟流程

用一般 JavaScript／TypeScript 串接 `run()`，檢查上一個結果後再交給下一個 agent。順序、平行執行、重試和模型升級由宿主程式決定；目前沒有內建 workflow 或自動 fallback。

Agentin 適合需要混用模型 API、CLI agent 與 MCP 工具的流程，提供共同的事件、結果、取消、逾時與清理介面。模型配置是否節省成本或時間，仍需依工作量與結果品質實測。

## 開發與專案狀態

目前是 alpha，尚未發布 npm。SDK、三種 runtime、函式工具橋接、Domain Ontology 與 Zod 輸出驗證已實作；session、圖片輸入、Terminal 聊天與瀏覽器探索範例尚未提供。真實 Claude／OpenCode 的工具限制與橋接仍待驗收。

```sh
npm run build     # 建置 SDK、Engine、Hub
npm test          # 底層與 SDK 測試
npm run test:sdk  # SDK 型別、單元與整合驗證
npm run check    # 建置並執行全部測試
```

一般測試使用假模型與替代 CLI，不需模型帳號；環境需允許本機 HTTP 與子程序操作。通過這些測試不代表真實模型品質或 CLI 權限行為已完成驗收。

- [API 與 runtime 詳細說明](docs/usage.md)
- [架構與責任](docs/architecture.md)
- [開發路線](docs/roadmap.md)
- [Engine](agent-engine/README.md)／[MCP Hub](mcp-hub/README.md)
- [開源交付待確認事項](docs/open-source-issues.md)
