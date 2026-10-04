# 架構與責任

## 原則與現況

Agentin 是對外整合層，不只是 repo 名稱。底下保留 `agent-engine/`、`mcp-hub/`，先以 private 本機套件嵌入，不發布。此文件描述目標架構。Engine／Hub 已搬入並通過本機建置與無模型測試；SDK 的 agent 定義、runtime 註冊、run／close 與 Claude CLI／OpenCode／Vercel AI runtime 包裝已實作；函式橋接待完成，session 最後再評估。

以 ai-guardianbot 的新版 Engine、Hub 與 runtime 路由設計為底層依據，參考 agent-studio（JackIn）的函式工具、宿主橋接與可選對話管理。兩邊底層版本不同，不整份複製；Guardian 的 code-defined agent／工具路由與 AI SDK loop 應保留。

## 模組分工

| 模組 | 責任 | 邊界 |
|---|---|---|
| `src/agentin.ts` | 註冊 runtime、組裝 engine／hub、派送執行、管理關閉 | 不決定業務階段、人工 gate 或任務驗收內容 |
| `src/agent.ts` | 定義 agent 身分、instructions、工具與能力 | 純定義，不持有連線或聊天狀態 |
| `src/tools/` | 定義函式工具、引用遠端 MCP 工具、驗證參數、橋接宿主函式 | 不決定業務工具的實際效果或自動重試 |
| `src/sessions/` | 可選歷史儲存、對話隔離、同一對話的重疊執行控制 | 不讓一次 take 自動擁有隱藏聊天歷史 |
| `src/index.ts` | 匯出穩定的主要 API | 底層 helper 不全部直接轉匯出 |
| `agent-engine/` | runtime 能力協商、一次 take 的執行、事件、usage、取消、逾時、程序清理、輸出解析與產物提交 | 不持有業務 prompt、不編排 workflow、不決定業務 fallback |
| `mcp-hub/` | 工具允許清單、schema、路由、上游連線、取消與錯誤分類、保留完整 MCP 結果 | 不理解 agent 業務、不決定下一步、不提供模型推理 |
| 外部宿主（Guardian 等） | 組裝業務 context、安排階段、驗收、人工核准、平台身分與權限 | Jira／Slack／E2E／DB／Playwright 腳本生成流程不搬進通用底層 |

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
- Hub `defineTool()` 是可序列化路由定義；宿主函式使用 `BuiltinTool.execute(args, signal)`，與下列目標 SDK 介面不同。
- Hub in-memory builtin 支援 schema 驗證與完整 MCP 結果；Engine 子程序不能直接接收 JS 函式，需 stdio server。ToolBridge 尚未接入。
- 保留來源版 Claude、AI SDK runner 與 experimental Codex；OpenCode adapter 已實作，真實 CLI 隔離待此 repo 驗證。
- Engine AgentManifest 保留來源相容欄位；公開 SDK 角色介面將由整合層收斂。

## 工具介面

- `defineTool()`：宿主函式實作，包含 schema 與 `execute(args, context)`。
- `mcpTool()`：遠端工具引用，包含對外 ID、server ID 與上游工具名。
- 兩種工具最後都走相同的允許清單。程式設定與檔案設定應共用驗證與路由模型，避免重複定義。
- 參考 JackIn ToolBridge：函式留在宿主，內部 stdio server 經本機橋接呼叫；每次 take 綁定獨立憑證、工具範圍與取消訊號。
- 工具取消是合作式的；忽略 signal 的宿主函式可能繼續執行。
- 工具結果需保留圖片、結構化資料與錯誤語意，不能全部轉成 JSON 字串。

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

1. 接入 Guardian 新版 Engine 與 Hub，保留既有模組名與責任。
2. 建立 Agentin 的純 agent 定義、runtime 註冊、`run()`／`close()`。
3. 借用並適配函式工具與 ToolBridge，加入 schema 驗證及完整工具結果。
4. 用 Guardian 的真實呼叫方式驗證整合，業務邏輯留在宿主。
5. 完成 Terminal 與瀏覽器探索範例；session 最後再評估是否納入。
6. 直接工具入口、Pi SDK 與自架模型接入留待後續。

暫不加入 Agency／Desk、排程、完整人工核准框架或 npm 發布流程。

## SDK 範圍補充

- Agentin 是可嵌入的開源 SDK；註冊與派發不代表內建任務排程或自主多 agent 協作。
- 第一版以 Claude CLI／OpenCode 驗證共通契約。Engine 現有 SpawnRuntime 不能直接假定涵蓋服務／SDK 型 runtime；接入時先確認生命週期與事件需求，再決定擴充 adapter 介面。
- `src/runtimes/` 負責 SDK 對外組裝與註冊；具體 adapter 與事件解析留在 Engine，避免重複實作。
- `tests/integration/` 驗證外層整合，Engine／Hub 的模組測試仍各自維護。
- `examples/terminal-chat/` 與 `examples/browser-explorer/` 尚未實作；瀏覽器例子先驗證探索與證據，Playwright 生成／重跑是後續業務範例。
- 目前不打包；發布前才加入乾淨安裝、公開型別、來源授權與交付驗證。
