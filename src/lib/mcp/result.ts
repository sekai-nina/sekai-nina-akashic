/**
 * MCP ツールの結果を組み立てる共通ヘルパー。`tools.ts` (アセット・エンティティ・聖地) と
 * `tools-articles.ts` (記事) で共有する。
 */

/** 未知エラーの詳細をツール結果に載せる最大長 */
const ERROR_DETAIL_MAX_LENGTH = 200;

/** ツール結果 (成功) — JSON をテキストとして返す */
export function ok(payload: unknown) {
  return {
    // インデントは付けない。AI 向け出力に整形は不要で、実測でトークンが 36% 増える
    // (同じ検索結果が pretty 27,575 文字 / compact 20,201 文字)
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

/** ツール結果 (失敗) — isError を立てて AI にリトライさせる */
export function fail(message: string, detail?: Record<string, unknown>) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, ...(detail ?? {}) }, null, 2),
      },
    ],
  };
}

/**
 * domain 層が投げた例外を AI に読める形へ落とす。
 * Prisma のエラーはスタックにサーバーのパスやクエリが載るので、そのままは返さない。
 */
export function toToolError(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("Access denied")) {
    return fail("クリアランスが足りないため、この操作は実行できません。");
  }
  if (message.includes("Unique constraint failed")) {
    return fail("同じものが既に登録されています。一覧で確認してから更新ツールを使ってください。");
  }
  if (message.includes("not found") || message.includes("No record was found")) {
    return fail("対象が見つかりません。ID を確認してください。");
  }

  // 未知のエラーは 1 行目だけ返す（スタックとクエリは落とす）
  return fail(fallback, { detail: message.split("\n")[0].slice(0, ERROR_DETAIL_MAX_LENGTH) });
}

