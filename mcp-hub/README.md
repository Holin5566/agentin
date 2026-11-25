# MCP Hub

共用的 MCP 工具邊界：允許清單、路由、上游連線、取消與錯誤分類。與 Agent Engine 分開使用，不負責推理或業務 workflow。

## 程式介面

```js
const { openGateway } = require('./mcp-hub/dist');
const hub = await openGateway({
  tools: ['echo'],
  catalog: {
    servers: [{ id: 'host', transport: 'in-memory' }],
    tools: [{ id: 'echo', serverId: 'host', toolName: 'echo' }],
  },
  builtinTools: [{
    name: 'echo', description: 'Echo a message',
    inputSchema: {
      type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false,
    },
    execute: async ({ message }) => message,
  }],
});
try {
  console.log(await hub.list());
  console.log(await hub.callResult('echo', { message: 'hello' }));
} finally {
  await hub.close();
}
```

程式需放在 async 函式內執行。

- `list()` 提供對外工具 ID、description 與 inputSchema。
- `callResult()` 保留 MCP content（含圖片／資源）、structuredContent、metadata 和 isError。
- `call()` 為文字便利介面，非文字內容不會出現在回傳字串；工具失敗 throw `ToolCallFailed`。
- 清單以外的工具在路由前拒絕；取消原樣往上傳。宿主函式需合作式處理 signal。
- Builtin 工具可回文字或完整 MCP CallToolResult；執行前以 JSON Schema 驗證參數。
- 外部 transport 支援 stdio、SSE、streamable HTTP；連線延遲初始化且並行共用。
- OAuth 可由 `npm run auth-login --prefix mcp-hub -- <server-id>` 處理。
- `close()` 有限期限等待清理；期限到不代表忽略 signal 的上游已停止。

## CLI 與外部 MCP

宿主 `manifests/mcp-servers/*.json` 宣告連線，可將工具路由寫在 manifest 或由 `loadCatalog(serverDir, toolDefinitions)` 傳入。

`npm run gateway --prefix mcp-hub -- --tools <ids>` 啟動 stdio gateway；`npm run check --prefix mcp-hub` 主動檢查上游。

跨程序工具請使用 `createBuiltinServer()`／`serveBuiltinStdio()`。in-memory 注入只在同一程序有效；Engine 不會把 JS 函式序列化到子程序。

## 驗證

`npm test --prefix mcp-hub` 建置並跑 179 個測試，涵蓋允許清單、schema、完整結果、取消、OAuth 與跨程序清理。不需外部 MCP 或模型帳號。

來源與授權狀態見 [來源紀錄](../docs/provenance.md)。
