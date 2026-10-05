# 開發路線

目前狀態：Engine／Hub 已接入，可獨立建置並通過 499 個底層無模型測試，另有 23 個 SDK 整合測試；新增完整工具結果、builtin schema 驗證與清理修正。來源公開授權待確認；SDK 公開入口與 Claude CLI／OpenCode／Vercel AI runtime 包裝已實作，另有無模型 SDK 整合測試與 basic 範例；函式工具橋接已實作，支援 Zod 4 型別推導與宿主解析；session 留待最後評估，產品範例尚未實作。

| 階段 | 工作 | 完成條件 |
|---|---|---|
| 1 | 確認可公開來源，接入 Engine／Hub | 通用程式不依賴公司設定；原有模組檢查可執行 |
| 2 | Agentin 公開入口與 Claude／Vercel AI runtime | 可定義 agent、派發、觀察事件、取消與關閉 |
| 3 | CLI runtime 真實驗證 | OpenCode adapter 與 CLI 契約測試已完成；待安裝、授權環境驗證實際工具限制與清理 |
| 4 | 函式工具與 MCP 接入 | schema 驗證、橋接隔離、錯誤分類與完整工具結果 |
| 5 | Terminal 範例 | 工具進度、停止與退出可用 |
| 6 | 瀏覽器探索範例 | 真實工具操作，產物可定位，成功條件有證據 |
| 7 | 開源交付準備 | 文件、來源授權、安裝與型別驗證；此時才決定 npm 發布 |

後續評估：Pi SDK、自架模型 runner、直接工具 API、context 策略，以及探索後產生／重跑 Playwright 的示範。

暫不擴充：Agency／Desk 框架、複雜排程、自主多 agent 協作與通用人工審核平台。

Session 留到最後再評估是否需要；若採用，再定義對話隔離、歷史與重疊執行契約。

首版品質以 runtime 契約與可重現範例衡量，不以 adapter 數量衡量。一般測試不使用模型帳號；真實 runtime 驗證應獨立且明確啟動。
