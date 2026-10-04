# 開發路線

目前狀態：Engine／Hub 已接入，可獨立建置並通過 492 個無模型測試；新增完整工具結果、builtin schema 驗證與清理修正。來源公開授權待確認；SDK 公開入口與 Claude runtime 包裝已實作，另有無模型 SDK 整合測試與 basic 範例；OpenCode、函式工具橋接、session 與產品範例尚未實作。

| 階段 | 工作 | 完成條件 |
|---|---|---|
| 1 | 確認可公開來源，接入 Engine／Hub | 通用程式不依賴公司設定；原有模組檢查可執行 |
| 2 | Agentin 公開入口與 Claude runtime | 可定義 agent、派發、觀察事件、取消與關閉 |
| 3 | OpenCode adapter | 兩個 runtime 的能力、事件、工具限制、失敗與清理皆有驗證 |
| 4 | 函式工具與 MCP 接入 | schema 驗證、橋接隔離、錯誤分類與完整工具結果 |
| 5 | Session 與 Terminal 範例 | 多輪聊天、新對話、停止、退出可用 |
| 6 | 瀏覽器探索範例 | 真實工具操作，產物可定位，成功條件有證據 |
| 7 | 開源交付準備 | 文件、來源授權、安裝與型別驗證；此時才決定 npm 發布 |

後續評估：Pi SDK、自架模型 runner、直接工具 API、context 策略，以及探索後產生／重跑 Playwright 的示範。

暫不擴充：Agency／Desk 框架、複雜排程、自主多 agent 協作與通用人工審核平台。

首版品質以兩個執行器與兩個可重現範例衡量，不以 adapter 數量衡量。一般測試不使用模型帳號；真實 runtime 驗證應獨立且明確啟動。
