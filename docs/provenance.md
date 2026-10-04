# 底層來源紀錄

2026-10-05 從本機 `ai-guardianbot/agent-engine` 與 `ai-guardianbot/mcp-hub` 工作副本搬入通用 `src/`、package manifest、lockfile 與 TypeScript 設定。

來源 repo HEAD：`4eb7071c29a0f0e2860f911977cd70667f99d8b2`。此紀錄指向來源 HEAD，搬入內容來自工作目錄，不能假定等同該 commit 的完整快照。

未搬入 Guardian 設定、憑證、業務 manifest、歷史說明或部署腳本。Claude stream fixture 的工作站設定已換成通用資料。

本次改動：

- Hub 公開 schema 與完整 MCP 結果，保留文字便利介面。
- Builtin 工具參數驗證與完整結果回傳。
- 預取消請求拒絕執行；失敗握手釋放連線；關閉等待加上期限。
- 根目錄安裝／建置／測試指令與不需模型的 smoke 範例。

來源授權與公開範圍尚未確認。本次只建立本機開發副本，沒有發布至 npm 或公開 repo；開源交付前仍需確認來源權利並決定 LICENSE。
