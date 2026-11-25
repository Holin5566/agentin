#!/usr/bin/env node
/**
 * 撥號每一台宣告的 MCP server,確認它連得上、而且 manifest 寫的工具名在上游真的存在。
 *
 * gateway 自己在 `tools/list` 時也會 fail loud,但那要等到某個 agent 真的去列工具
 * 才會發現 —— 而那時候使用者已經在等回覆了。這支是主動檢查:換機、加上游、改
 * manifest 之後跑一次,把 `getJiraIssue` vs `jira_get_issue` 這種錯字當場抓出來。
 *
 *   node dist/bin/check.js                      # 全部
 *   node dist/bin/check.js --server jira        # 只撥這台(冷啟動很慢的上游用)
 *   node dist/bin/check.js --list-tools         # 印出上游實際工具名,照著抄進 manifest
 *
 * 離開碼:有任何一台連不上或有 missing 就 1,否則 0 —— 讓它能直接當 CI 的一關。
 */
import { checkServers } from '../hub.js';
import { parseCheckArgs } from './args.js';

async function main(): Promise<void> {
  const args = parseCheckArgs(process.argv.slice(2));
  const rows = await checkServers(args.only ? { only: args.only } : {});

  if (rows.length === 0) {
    // 空不是錯:一個完全不用外部工具的專案是合法的。但要講出來,否則看起來像沒跑到。
    console.log('沒有宣告任何 MCP server（manifests/mcp-servers/ 是空的)');
    return;
  }

  let bad = 0;
  for (const r of rows) {
    if (!r.ok) {
      bad++;
      console.log(`✗ ${r.id} [${r.transport}] 連線失敗 — ${r.error}`);
    } else if (r.missing.length > 0) {
      bad++;
      // 這是這支程式存在的主要理由,所以講清楚是哪幾個名字對不上。
      console.log(
        `✗ ${r.id} [${r.transport}] 上游 ${r.upstreamTools} 個工具,` +
        `但宣告的 ${r.missing.length} 個不存在:${r.missing.join(', ')}`,
      );
    } else {
      console.log(
        `✓ ${r.id} [${r.transport}] 上游 ${r.upstreamTools} 個工具,` +
        `宣告的 ${r.declared.length} 個全部對得上`,
      );
    }
    if (args.listTools && r.upstreamNames) {
      for (const name of r.upstreamNames) console.log(`    ${name}`);
    }
  }

  if (bad > 0) {
    console.log(`\n${bad}/${rows.length} 台有問題`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  // 參數錯、server id 打錯這類一律非 0 —— 「什麼都沒驗」不可以看起來像通過。
  console.error(`check 失敗: ${e?.message ?? e}`);
  process.exit(1);
});
