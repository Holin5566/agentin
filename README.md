# Agentin

Agentin 是開發中的 TypeScript 開源 SDK，讓應用定義不同角色的 agent，透過共用介面派發任務，接入不同執行器與工具。

應用整合 agent 時，往往需要自行處理各家執行器的事件、工具權限、取消、逾時與結果。Agentin 將這些接線集中管理，讓 Terminal、Web 與業務服務能專注在自己的流程。

## 專案狀態

Engine／Hub 已搬入，可獨立建置並通過 492 個無模型測試。Engine 已有一次 take 的執行、事件、取消、逾時與產物管理；Hub 已有允許清單、MCP 路由、builtin schema 驗證與完整結果介面。Agentin 已提供 `defineAgent()`、`createAgentin()`、`run()`、`close()` 與 Claude runtime 註冊。OpenCode adapter、函式工具橋接、session 與聊天／瀏覽器產品範例尚未實作。第一版仍聚焦 Claude CLI 與 OpenCode。

`agent-engine/` 和 `mcp-hub/` 直接嵌在 repo 根目錄，目前只使用 private package 管理本機相依與建置，不做 registry 發布。正式交付前再驗證建置、安裝與公開型別；不將規劃功能列為已完成。

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

| 能力 | 目標 |
|---|---|
| Agent 定義與派發 | 角色指示、工具範圍與 runtime 選擇 |
| 兩種執行器 | Claude CLI、OpenCode；接入方式按各自能力設計 |
| 工具 | 宿主函式、外部 MCP、參數驗證與明確允許清單 |
| 執行契約 | 事件、取消、逾時、錯誤分類、輸出解析與產物 |
| 對話 | 明確 session ID、基本歷史與同一對話的執行控制 |
| Terminal 範例 | 多輪聊天、工具進度、停止、新對話與退出 |
| 瀏覽器範例 | 使用 MCP 探索頁面，保存可驗收的探索證據 |
| 驗證 | 無模型的契約測試、可選的真實 runtime 驗證；交付時加入乾淨安裝與型別驗證 |

瀏覽器探索後產生 Playwright 腳本與重跑驗收是後續範例延伸，不作為底層 SDK 的內建業務流程。

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

Agent 是角色與能力宣告；runtime 是執行方式。切換 runtime 前須驗證能力相容，不承諾不同執行器行為完全相同。runtime 選擇順序為單次 `run.runtime` → agent 的 `runtime` → `defaultRuntime`。SDK 的原生檔案與 shell 權限預設關閉，必須用 `capabilities` 明確開啟。工具目前接受 Hub 路由物件或 ID；宿主函式橋接尚未實作。

`run()` 支援 `signal`、`onEvent`、`timeoutMs`、`model`、`maxOutputBytes` 與 `parseOutput`。結果包含 runtime 名称以及 Engine 的狀態、stopReason、usage、產物與 cleanup。設定錯誤 reject `EngineError`；執行與能力失敗依結果模型回報。`close()` 取消所有進行中的工作，重複呼叫回同一份關閉 Promise。

聊天將透過可選 session 使用相同執行入口，Terminal UI 由宿主負責。

## 目錄與責任

```text
agentin/
├── src/                         SDK 對外整合層
│   ├── agentin.ts               註冊、派發、生命週期
│   ├── agent.ts                 純 Agent 定義
│   ├── runtimes/                runtime adapter 與能力映射的整合
│   ├── tools/                   函式工具、MCP 引用與宿主橋接
│   ├── sessions/                可選對話管理
│   └── index.ts                 公開 API
├── agent-engine/                一次 take 的執行與結果管理
├── mcp-hub/                     工具允許清單、路由與上游連線
├── examples/
│   ├── terminal-chat/           規劃：自己的 Terminal 聊天
│   └── browser-explorer/        規劃：瀏覽器探索與證據
├── tests/integration/           SDK 與底層整合驗證
├── scripts/                     後續的驗證／交付腳本
├── docs/
│   ├── architecture.md          分工與執行契約
│   └── roadmap.md               範圍、順序與完成條件
└── README.md
```

SDK 公開入口與 `examples/basic.cjs` 已實作，函式工具、session 與產品範例的空目錄仍使用 `.gitkeep` 保留。Engine／Hub 已有實際程式與模組測試。Engine 的 adapter 實作歸 Engine；`src/runtimes/` 負責對外設定與註冊，避免重複維護兩套 adapter。

## 架構

```text
Terminal／Web／業務服務
            ↓
     Agentin 公開 API
            ↓
       Agent Engine
      ├── Claude CLI
      └── OpenCode
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
- 業務 workflow、平台登入與任務驗收由宿主負責。

參考設計來自 Guardian 的執行管理與 JackIn 的函式工具接入。公開程式前須確認來源授權與可公開範圍；範例使用通用資料，不含公司憑證、內部網址或業務紀錄。授權與貢獻規範待公開前確認。

完整說明：[架構與責任](docs/architecture.md)、[開發路線](docs/roadmap.md)。
