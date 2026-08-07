import { McpServer, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { ApiKeyUser } from "@/lib/api-auth";
import { registerAkashicTools } from "./tools";
import { resolveAppBaseUrl } from "./format";

const SERVER_INFO = {
  name: "akashic",
  title: "Akashic",
  version: "1.0.0",
} as const;

const INSTRUCTIONS = [
  "Akashic は坂井新奈 (日向坂46) の内部向けアーカイブ・検索システムです。",
  "アセット (画像・動画・ブログ本文・トークなど) を検索・取得し、下書きの登録や聖地の登録ができます。",
  "",
  "使い方の要点:",
  "- 登録・更新の前に akashic_search / akashic_list_entities / akashic_list_places で既存を確認する (重複登録を避ける)。",
  "- エンティティは名前で指定する。一致しなかった名前は紐づかず unresolvedEntities として返るので、",
  "  正式名称を調べ直すか、新規で問題ないと確認できたときだけ createMissingEntities: true を付ける。",
  "- akashic_create_asset で作ったアセットは必ず status=inbox に入る。人間が仕分けする前提の下書きとして扱う。",
  "- 日付は JST 基準。canonicalDate は投稿日ではなく「内容の公開日・放送日」を入れる。",
].join("\n");

/** authInfo.extra 経由でツール層に渡す API キーの持ち主 */
const AUTH_EXTRA_USER_KEY = "akashicUser";

export function toAuthInfo(user: ApiKeyUser, token: string): AuthInfo {
  return {
    token,
    clientId: user.apiKeyId,
    scopes: user.permissions,
    extra: { [AUTH_EXTRA_USER_KEY]: user },
  };
}

/**
 * Akashic の MCP ハンドラ。
 *
 * factory は 1 リクエストにつき 1 回呼ばれ、そのリクエストの authInfo を受け取る。
 * ここでキーの permissions を見てツールを出し分けるので、read だけのキーには
 * 書き込みツールが tools/list にすら現れない。
 */
export const akashicMcpHandler = createMcpHandler(
  (ctx) => {
    const user = ctx.authInfo?.extra?.[AUTH_EXTRA_USER_KEY] as ApiKeyUser | undefined;
    if (!user) {
      // ルート側で requireApiAuth を通しているのでここには来ない
      throw new Error("MCP handler invoked without authenticated API key");
    }

    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    registerAkashicTools(server, {
      user,
      baseUrl: ctx.requestInfo ? resolveAppBaseUrl(ctx.requestInfo) : "",
    });
    return server;
  },
  {
    onerror: (error) => {
      console.error("[mcp] handler error:", error);
    },
  }
);
