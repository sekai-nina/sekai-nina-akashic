/**
 * MCP サーバー (/api/mcp) のスモークテスト。
 *
 * Usage:
 *   pnpm cli:mcp-check <baseUrl> <apiKey> [--write] [--q <検索語>]
 *   pnpm cli:mcp-check http://localhost:3000 ak_xxxx
 *   pnpm cli:mcp-check https://akashic.example.com ak_xxxx --write
 *
 * このリポジトリにはテストが無いので、initialize → tools/list → 各ツールを
 * 実際に叩いて壊れていないことを確認する用途。--write を付けたときだけ
 * 書き込みツール (アセットの作成・更新) も実行する。作られたアセットは
 * inbox に入るので、確認後に画面から削除すること。
 */

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

let requestId = 0;
let failures = 0;

function ok(label: string, detail: string) {
  console.log(`  [32m✓[0m ${label.padEnd(24)} ${detail}`);
}

function ng(label: string, detail: string) {
  failures++;
  console.log(`  [31m✗[0m ${label.padEnd(24)} ${detail}`);
}

/** SSE で返ってきた場合に data: 行から JSON を取り出す */
function parseSseBody(body: string): JsonRpcResponse | null {
  for (const chunk of body.split(/\n\n+/)) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcResponse;
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
    } catch {
      // 次のイベントを見る
    }
  }
  return null;
}

async function rpc(
  endpoint: string,
  apiKey: string,
  method: string,
  params?: unknown,
  notification = false
): Promise<{ result?: unknown; error?: JsonRpcResponse["error"]; ms: number }> {
  const started = Date.now();
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  if (!notification) body.id = ++requestId;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${apiKey}`,
      "mcp-protocol-version": PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
  });

  const ms = Date.now() - started;

  if (notification) {
    if (res.status >= 400) {
      return { error: { code: res.status, message: `HTTP ${res.status}` }, ms };
    }
    return { ms };
  }

  const text = await res.text();

  if (res.status >= 400 && !text.trim().startsWith("{")) {
    return { error: { code: res.status, message: `HTTP ${res.status}: ${text.slice(0, 200)}` }, ms };
  }

  const contentType = res.headers.get("content-type") ?? "";
  let parsed: JsonRpcResponse | null = null;

  if (contentType.includes("text/event-stream")) {
    parsed = parseSseBody(text);
  } else {
    try {
      parsed = JSON.parse(text) as JsonRpcResponse;
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    return { error: { code: -1, message: `レスポンスを解釈できません: ${text.slice(0, 200)}` }, ms };
  }
  if (parsed.error) return { error: parsed.error, ms };
  return { result: parsed.result, ms };
}

/** tools/call を叩き、テキストコンテンツを JSON としてパースして返す */
async function callTool(
  endpoint: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ data?: unknown; isError: boolean; message: string; ms: number }> {
  const { result, error, ms } = await rpc(endpoint, apiKey, "tools/call", {
    name,
    arguments: args,
  });

  if (error) return { isError: true, message: `${error.code}: ${error.message}`, ms };

  const toolResult = result as ToolResult;
  const text = toolResult.content?.find((c) => c.type === "text")?.text ?? "";

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    data,
    isError: Boolean(toolResult.isError),
    message: toolResult.isError ? text.slice(0, 300) : "",
    ms,
  };
}

async function main() {
  const argv = process.argv.slice(2);

  const usage = (message?: string) => {
    if (message) console.error(`Error: ${message}\n`);
    console.error("Usage: pnpm cli:mcp-check <baseUrl> <apiKey> [--write] [--q <検索語>]");
    console.error("Example: pnpm cli:mcp-check http://localhost:3000 ak_xxxx");
    console.error("         pnpm cli:mcp-check http://localhost:3000 ak_xxxx --q 坂井新奈 --write");
    process.exit(1);
  };

  let withWrite = false;
  let searchTerm = "ブログ";
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") {
      withWrite = true;
    } else if (arg === "--q") {
      const value = argv[i + 1];
      // 値なし (末尾) や、値の位置に別のフラグが来ている場合は検索語が黙って壊れる
      if (value === undefined || value.startsWith("--")) {
        usage("--q には検索語が必要です");
      }
      searchTerm = value!;
      i++;
    } else if (arg.startsWith("--q=")) {
      const value = arg.slice("--q=".length);
      if (!value) usage("--q= には検索語が必要です");
      searchTerm = value;
    } else if (arg.startsWith("--")) {
      usage(`不明なオプション: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [baseUrl, apiKey] = positional;

  if (!baseUrl || !apiKey) usage("baseUrl と apiKey は必須です");
  if (positional.length > 2) usage(`引数が多すぎます: ${positional.slice(2).join(" ")}`);
  if (!/^https?:\/\//.test(baseUrl)) usage(`baseUrl は http(s):// で始めてください: ${baseUrl}`);
  if (!apiKey.startsWith("ak_")) usage(`apiKey は ak_ で始まる必要があります: ${apiKey}`);

  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/mcp`;
  console.log(`\nMCP smoke check: ${endpoint}\n`);

  // --- initialize ---
  const init = await rpc(endpoint, apiKey, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "akashic-mcp-check", version: "1.0.0" },
  });

  if (init.error) {
    ng("initialize", `${init.error.code}: ${init.error.message}`);
    console.log("\n初期化に失敗したので中断します。URL と API キーを確認してください。\n");
    process.exit(1);
  }

  const initResult = init.result as {
    protocolVersion?: string;
    serverInfo?: { name?: string; version?: string };
  };
  ok(
    "initialize",
    `protocol ${initResult.protocolVersion} / ${initResult.serverInfo?.name}@${initResult.serverInfo?.version} (${init.ms}ms)`
  );

  await rpc(endpoint, apiKey, "notifications/initialized", {}, true);

  // --- tools/list ---
  const list = await rpc(endpoint, apiKey, "tools/list", {});
  if (list.error) {
    ng("tools/list", `${list.error.code}: ${list.error.message}`);
    process.exit(1);
  }

  const tools = (list.result as { tools: Array<{ name: string }> }).tools;
  const names = tools.map((t) => t.name);
  const writeTools = names.filter((n) => /_(create|update)_/.test(n));
  ok(
    "tools/list",
    `${names.length} tools (read ${names.length - writeTools.length} / write ${writeTools.length}) — ${names.join(", ")} (${list.ms}ms)`
  );

  // --- 読み取りツール ---
  const searchRes = await callTool(endpoint, apiKey, "akashic_search", {
    q: searchTerm,
    perPage: 3,
  });
  let firstAssetId: string | undefined;
  if (searchRes.isError) {
    ng("akashic_search", searchRes.message);
  } else {
    const data = searchRes.data as { total: number; items: Array<{ id: string; title: string }> };
    firstAssetId = data.items[0]?.id;
    ok("akashic_search", `q="${searchTerm}" total=${data.total}, ${data.items.length} items (${searchRes.ms}ms)`);
  }

  if (firstAssetId) {
    const getRes = await callTool(endpoint, apiKey, "akashic_get_asset", { id: firstAssetId });
    if (getRes.isError) {
      ng("akashic_get_asset", getRes.message);
    } else {
      const data = getRes.data as { id: string; title: string; texts: unknown[] };
      ok("akashic_get_asset", `${data.id} "${data.title}" texts=${data.texts.length} (${getRes.ms}ms)`);
    }
  } else {
    ok("akashic_get_asset", "スキップ (検索結果が 0 件)");
  }

  const entitiesRes = await callTool(endpoint, apiKey, "akashic_list_entities", {
    type: "person",
    perPage: 5,
  });
  if (entitiesRes.isError) {
    ng("akashic_list_entities", entitiesRes.message);
  } else {
    const data = entitiesRes.data as { total: number; items: Array<{ name: string }> };
    ok("akashic_list_entities", `person total=${data.total} (${entitiesRes.ms}ms)`);
  }

  const placesRes = await callTool(endpoint, apiKey, "akashic_list_places", {});
  if (placesRes.isError) {
    ng("akashic_list_places", placesRes.message);
  } else {
    const data = placesRes.data as { total: number };
    ok("akashic_list_places", `total=${data.total} (${placesRes.ms}ms)`);
  }

  // --- 書き込みツール (--write のときだけ) ---
  if (!withWrite) {
    console.log("\n  書き込みツールは未実行 (--write を付けると実行します)");
  } else if (writeTools.length === 0) {
    ng("write tools", "このキーには write 権限が無いため書き込みツールが出ていません");
  } else {
    const stamp = new Date().toISOString();
    const createRes = await callTool(endpoint, apiKey, "akashic_create_asset", {
      kind: "text",
      title: `[MCPスモークテスト] ${stamp}`,
      bodyText: "cli:mcp-check が作成したテスト用アセットです。確認後に削除してください。",
    });

    if (createRes.isError) {
      ng("akashic_create_asset", createRes.message);
    } else {
      const created = createRes.data as { id: string; status: string; url: string };
      ok("akashic_create_asset", `${created.id} status=${created.status} (${createRes.ms}ms)`);

      const updateRes = await callTool(endpoint, apiKey, "akashic_update_asset", {
        id: created.id,
        description: "cli:mcp-check による更新確認",
        upsertTexts: [{ textType: "note", content: "更新テスト" }],
      });
      if (updateRes.isError) {
        ng("akashic_update_asset", updateRes.message);
      } else {
        ok("akashic_update_asset", `${created.id} 更新 OK (${updateRes.ms}ms)`);
      }

      console.log(`\n  ⚠ テスト用アセットが inbox に残っています: ${created.url}`);
    }
  }

  console.log(
    failures === 0
      ? "\n[32mすべて成功しました。[0m\n"
      : `\n[31m${failures} 件失敗しました。[0m\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
