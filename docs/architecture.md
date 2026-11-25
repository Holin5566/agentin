# 架構與責任

## 原則與現況

Agentin 將三項能力組合在同一個 SDK：

- **Agent Engine** 管理單次任務的 runtime、事件、取消及清理。
- **Scoped MCP Hub** 依 agent 的允許清單驗證和派送工具。
- **Domain Ontology** 在資料查詢前，將領域別名轉成可驗證的實體與目標。

```sh
npm run setup
npm run smoke:ontology
```

Smoke 使用本機圖與付款服務 fixture。完整 MCP 路徑由 SDK 整合測試覆蓋，測試使用本機替代模型。

## 模組分工

| 模組 | 責任 | 邊界 |
|---|---|---|
| `src/agentin.ts` | 註冊 runtime、組裝 engine／hub、派送執行、管理關閉 | 不決定業務階段、人工 gate 或任務驗收內容 |
| `src/agent.ts` | 定義 agent 身分、instructions、工具與能力 | 純定義，不持有連線或聊天狀態 |
| `src/ontology/` | 驗證圖、依路由解別名、推導目標、產生澄清候選與宿主工具 | 宿主掌管授權與資料派送 |
| `src/tools/` | 定義函式工具、引用遠端 MCP 工具、驗證參數、橋接宿主函式 | 不決定業務工具的實際效果或自動重試 |
| `src/sessions/` | 可選歷史儲存、對話隔離、同一對話的重疊執行控制 | 不讓一次 take 自動擁有隱藏聊天歷史 |
| `src/index.ts` | 匯出穩定的主要 API | 底層 helper 不全部直接轉匯出 |
| `agent-engine/` | runtime 能力協商、一次 take 的執行、事件、usage、取消、逾時、程序清理、輸出解析與產物提交 | 不持有業務 prompt、不編排 workflow、不決定業務 fallback |
| `mcp-hub/` | 工具允許清單、schema、路由、上游連線、取消與錯誤分類、保留完整 MCP 結果 | 不理解 agent 業務、不決定下一步、不提供模型推理 |
| 外部宿主（Host Application） | 組裝業務 context、安排階段、驗收、人工核准、平台身分與權限 | Jira／Slack／E2E／DB／Playwright 腳本生成流程不搬進通用底層 |

## SDK 目前執行行為

Agent 定義不持有資源且不可變；服務建立時快照註冊資料，不啟動外部程序。每個註冊 runtime 按需建立一個自有 Engine，支援並行 take。run 層、agent 層與服務預設依序決定 runtime；不自動 fallback。

SDK 預設 capabilities 為 filesystem none、shell false，避免底層的省略權限行為意外開放原生工具。Engine 負責 capability 協商、事件與程序清理；SDK 保留其結果並加上註冊 runtime 名稱。注入 artifact store 不由 SDK 關閉。

close 立即停止接受執行，取消所有已建立 Engine 的進行中工作，等待各 Engine 的有限期限關閉；可重複呼叫。不含 session 或隱藏聊天歷史。

## 三種使用路徑

1. **一次任務**：宿主 → Agentin `run()` → Engine → runtime → Hub → 工具；結果回宿主驗收。宿主可提供 signal、事件、模型選擇與輸出解析。
2. **聊天（最後評估是否納入）**：宿主 → 明確建立的 session → 歷史組裝 → 同一 `run()` 路徑 → 保存成功回覆。服務端使用明確對話 ID，不隱含共用 default 對話。
3. **直接工具呼叫（後續）**：宿主 → Agentin 工具入口 → Hub → 上游工具，不需要模型。應提供 schema 與完整結果，文字便利介面可另外保留。

## 現有底層與目標介面的差異

- Engine 現有入口為 `createAgentEngine()`／`runTake()`；Agentin 的 `run()` 組裝角色 instructions 與 input，委派給所選 runtime 的 Engine。
- Hub `defineTool()` 是可序列化路由定義；宿主函式使用 `BuiltinTool.execute(args, signal)`；SDK `defineTool()` 使用 `execute(args, context)`，橋接後走同一 Hub 邊界。
- Hub in-memory builtin 支援 schema 驗證與完整 MCP 結果；Engine 子程序不能直接接收 JS 函式，需 stdio server。SDK ToolBridge 已接入，以 per-run loopback 端點與 stdio proxy 保留宿主函式。
- 保留來源版 Claude、AI SDK runner 與 experimental Codex；OpenCode adapter 已實作，真實 CLI 隔離待此 repo 驗證。
- Engine AgentManifest 保留來源相容欄位；公開 SDK 角色介面將由整合層收斂。

## 工具介面

- `defineTool()`：宿主函式實作，包含 schema 與 `execute(args, context)`。
- `mcpTool()`：遠端工具引用，包含對外 ID、server ID 與上游工具名。
- 兩種工具最後都走相同的允許清單。程式設定與檔案設定應共用驗證與路由模型，避免重複定義。
- ToolBridge 設計：函式留在宿主，內部 stdio server 經本機橋接呼叫；每次 take 綁定獨立憑證、工具範圍與取消訊號。
- 工具取消是合作式的；忽略 signal 的宿主函式可能繼續執行。
- 工具結果需保留圖片、結構化資料與錯誤語意，不能全部轉成 JSON 字串。

## Domain Ontology

### 圖結構

宿主把 JSON 資料或 TypeScript 物件交給 `createOntology(definition)`，SDK 驗證並建立私有快照。也可先用 `validateOntology(data)` 取得驗證錯誤清單。

| 元件 | 用途 |
|---|---|
| `kinds`、`entities` | 定義實體類型與穩定 ID，例如 `alpha-group`、`shop-a`。 |
| `labels` | 每個別名透過 `denotes` 指向一或多個實體。比對為完整別名比對，使用 NFKC、小寫及分隔符正規化。 |
| `relations`、`edges` | 宣告有向關係的起點、終點類型與每個起點的出邊基數。每個起點的同類關係最多有一條預設邊。 |
| `routes` | 固定查詢的起點類型與依序走過的關係。空路徑回傳起點。 |

驗證攔截錯誤資料型別、重複 ID、正規化後撞名的別名、未知實體或關係、重複邊、錯誤端點、基數違反、多重預設值與無法串接的路徑。範例見 [ontology-graph.json](../examples/ontology-graph.json)。

### 路由與澄清

1. 以路由的起點類型篩選別名的 `denotes`。同一個 `Alpha` 在群組路由對應 `alpha-group`，在租戶路由對應 `shop-a`。同類型仍有多個來源時，回傳 `clarification`，請呼叫者選 `source.entityId`。
2. 沿路由關係走訪，去重所有可達的終點。單一終點直接命中。多個終點時，逐跳考慮可達終點的分支，分支有唯一可行選項就繼續，有預設邊就走預設邊。預設值只能在這條路徑完整推導出單一終點時生效。
3. 仍有歧義時回傳排序後的 `targetId` 候選，結果不含選定目標。呼叫者可以提供明確 `targetId`，resolver 會驗證它在原路徑上可達。未知來源、未知路由、沒有可達目標或明確目標無法到達，均回傳可識別原因的 `not_found`。

`createOntologyTool(ontology)` 將解析結果包成 `ontology_resolve` 的 MCP 內容與結構化資料，可透過 SDK 的宿主函式橋接加入任一 agent。涉及資料查詢時，由宿主用固定的業務路由先解析，對 `clarification` 或 `not_found` 暫停派送。只有確認來源與目標後才查詢，後續選擇值取自呼叫者確認。多租戶服務應在工具註冊前選用呼叫者有權看見的圖，以免候選清單暴露其他租戶，派送時仍要驗證身分與資料存取權限。Hub 的允許清單控制工具可見性及可呼叫範圍。

## Runtime 與執行政策

第一版接 Claude CLI、Vercel AI 與OpenCode；Pi SDK、自架模型 runner 後續評估。Runtime 使用宿主註冊名稱，例如 `claude`、`opencode`，不把 AI SDK 的實作套件名稱固定成產品概念。Executor 與模型來源是不同維度；同一 runner 可以接不同 provider。

Agent 定義與執行服務分離。Agentin 管理共用 runtime／engine 的生命週期；每次 take 保留自己的工具範圍、事件與結果。多模態支援與其他能力應在執行前檢查。

Fallback 預設關閉。啟用時須考量工具是否已產生副作用；不能因 runtime 錯誤就重播整個任務。測試 FAIL、取消、設定錯誤與輸出不合格不能默默更換執行器重跑。

Engine 的成功狀態代表執行與輸出契約通過，不代表任務事實必然正確；業務驗收由宿主與執行證據完成。

## 生命週期與診斷

- 建立服務不啟動外部程序；執行時按需要初始化。
- `close()` 停止工作並釋放自有資源；注入資源的所有權必須明確。
- 設定／環境／上游連線／模型試跑分開檢查；模型試跑是明確選擇的操作。
- 程式使用錯誤可 throw；執行失敗、取消與逾時使用一致結果模型。具體錯誤碼與介面待實作確認。
- take ID 應串起 Agentin、Engine、Hub 的執行紀錄。

## 實作順序

1. 整合 Engine 與 MCP Hub 核心模組，明確劃分執行與工具路由責任。
2. 建立 Agentin 的純 agent 定義、runtime 註冊、`run()`／`close()`。
3. 借用並適配函式工具與 ToolBridge，加入 schema 驗證及完整工具結果。
4. 以宿主端的真實呼叫場景驗證整合，具體業務邏輯留在宿主應用。
5. 完成 Terminal 與瀏覽器探索範例；session 最後再評估是否納入。
6. 直接工具入口、Pi SDK 與自架模型接入留待後續。

暫不加入 Agency／Desk、排程、完整人工核准框架或 npm 發布流程。

## SDK 範圍補充

- Agentin 是可嵌入的開源 SDK；註冊與派發不代表內建任務排程或自主多 agent 協作。
- 第一版以 Claude CLI／OpenCode 驗證共通契約。Engine 現有 SpawnRuntime 不能直接假定涵蓋服務／SDK 型 runtime；接入時先確認生命週期與事件需求，再決定擴充 adapter 介面。
- `src/runtimes/` 負責 SDK 對外組裝與註冊；具體 adapter 與事件解析留在 Engine，避免重複實作。
- `tests/unit/` 驗證 ontology 圖與路由，`tests/integration/` 驗證 SDK 與 Scoped MCP Hub 的工具整合。Engine 與 Hub 各自維護模組測試。
- `examples/terminal-chat/` 與 `examples/browser-explorer/` 尚未實作；瀏覽器例子先驗證探索與證據，Playwright 生成／重跑是後續業務範例。
- 目前不打包；發布前才加入乾淨安裝、公開型別、來源授權與交付驗證。
