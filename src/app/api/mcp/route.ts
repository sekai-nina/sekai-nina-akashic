import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { akashicMcpHandler, toAuthInfo } from "@/lib/mcp/server";

/**
 * Akashic の MCP エンドポイント (Streamable HTTP)。
 *
 * 認証は REST API v1 と同じ API キー (`Authorization: Bearer ak_...`)。
 * 認証はここで済ませ、検証済みの ApiKeyUser を authInfo に載せてハンドラへ渡す
 * (= SDK 側はトークン検証を一切行わない pass-through)。
 *
 * `read` は認証の最低条件。書き込みツールを出すかどうかは
 * registerAkashicTools がキーの permissions を見て決める。
 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const token = request.headers.get("authorization")!.slice("Bearer ".length);

  return akashicMcpHandler.fetch(request, {
    authInfo: toAuthInfo(auth, token),
  });
}
