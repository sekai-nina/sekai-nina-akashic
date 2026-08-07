import { logAudit } from "@/lib/domain/audit";
import type { ApiKeyUser } from "@/lib/api-auth";

/** metadata に載せる引数値の最大長 (本文まるごと入れると AuditLog が膨れる) */
const ARG_MAX_LENGTH = 200;

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      out[key] =
        value.length > ARG_MAX_LENGTH
          ? `${value.slice(0, ARG_MAX_LENGTH)}…(${value.length}文字)`
          : value;
    } else if (Array.isArray(value)) {
      out[key] = `[${value.length}件]`;
    } else if (value !== null && typeof value === "object") {
      out[key] = "[object]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * MCP 経由の書き込みを監査ログに残す。
 *
 * domain 層が出す `asset.create` などとは別に `mcp.<tool>` を 1 本足す。
 * actorId (= キーの持ち主) だけでは人間の操作と区別できないため。
 * 読み取りツールは件数が多いので記録しない。
 *
 * **例外を投げない。** 呼ばれる時点で本体の書き込みは既にコミット済みなので、
 * ここで throw すると成功した作成が「失敗」として返り、AI がリトライして
 * inbox に同じ下書きが二重に入る。監査ログの取りこぼしはログに出すだけに留める。
 */
export async function logMcpToolCall(params: {
  user: ApiKeyUser;
  tool: string;
  targetType: string;
  targetId: string;
  args: Record<string, unknown>;
}) {
  try {
    await logAudit({
      actorId: params.user.id,
      action: `mcp.${params.tool}`,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: {
        apiKeyId: params.user.apiKeyId,
        tool: params.tool,
        args: summarizeArgs(params.args),
      },
    });
  } catch (err) {
    console.error(`[mcp] 監査ログの記録に失敗しました (${params.tool} ${params.targetId}):`, err);
  }
}
