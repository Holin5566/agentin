# Agent Engine

一次任務的執行核心，來自 Guardian 的 Engine 工作副本。公開入口為 `src/index.ts`，建置後可由 `dist/index.js` 匯入。

## 使用

在 repo 根目錄執行 `npm run setup`、`npm run build`。

```js
const { createAgentEngine, defineAgent, createMemoryStore } = require('./agent-engine/dist');
const agent = defineAgent({
  id: 'assistant',
  tools: [],
  capabilities: { filesystem: 'none', shell: false },
});
const engine = createAgentEngine({
  root: process.cwd(), agents: [agent], artifacts: createMemoryStore(),
});
try {
  const result = await engine.runTake({ agent, prompt: '用繁體中文說明什麼是 SDK', timeoutMs: 30000 });
  console.log(result.status, result.output);
} finally {
  await engine.close();
}
```

預設使用已安裝並授權的 Claude CLI。上述程式需放在 async 函式內執行。`npm run smoke` 提供不需模型的可執行整合範例。

## 契約

- 建立時不啟動程序；`runTake()` 使用明確 agent 定義，`check()` 驗證已註冊的 agent。
- 結果狀態為 `ok`、`error`、`cancelled`、`truncated`；`stopReason` 提供具體原因。
- 每個 take 的事件含 ID、時間、递增序號與唯一 `completed` 終態。
- 支援 AbortSignal、wall-clock 逾時、輸出上限、輸出解析與明確的 salvage；不自動切換 runtime 或重播任務。
- 成功且解析通過後才提交版本化產物。記憶體／檔案 store 可注入。
- `close()` 取消進行中的工作，有限期限等待程序清理；結果的 `cleanup` 可能是 `unconfirmed`。
- 工具宣告經 per-take gateway 允許清單落實，臨時路由檔在結束時移除。

## Runtime 與限制

目前保留 Claude CLI、AI SDK 子程序 runner，以及 experimental Codex adapter。OpenCode adapter 已加入，支援 JSON 事件與 per-take MCP 設定轉換；真實 binary／模型驗證待完成。AI SDK runner 可接 Anthropic／OpenAI 相容 provider，來源版本的工具結果送回模型路徑目前仍以文字為主。

原生工具權限需明確傳 `capabilities`；省略保留來源版的原生工具預設行為。`tools: []` 只代表沒有 Hub 工具，不會自動關閉原生工具。Claude 的 `workspace-write` 是工具名單映射，並非 OS 檔案沙箱。額外 `mcpServers` 為宿主信任的直接接入，不經 Hub 允許清單。

宿主 JS 函式不能直接跨程序注入；`builtinTools` 非空時會拒絕。CLI 工具請透過 Hub 的 `serveBuiltinStdio()` 做成真正的 stdio MCP server；Agentin SDK 的 `defineTool()` 已提供宿主函式橋接，透過每次執行的臨時 stdio 上游接入 Engine。

## 驗證

`npm test --prefix agent-engine` 會先建置 Hub，再跑型別與 320 個測試；模型 HTTP 使用本機假 server，不需模型帳號。測試環境需允許 loopback HTTP、程序訊號及 `ps`。

來源與授權狀態見 [來源紀錄](../docs/provenance.md)。
