import type { ZodError } from "zod";

/**
 * zod のエラーを 1 行の日本語にまとめる。REST の 400 と MCP の失敗結果で同じ形にする
 * (`path: message / path: message`)。
 */
export function formatZodError(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join(" / ");
}
