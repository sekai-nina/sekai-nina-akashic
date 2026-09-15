import { createHash } from "node:crypto";

/**
 * git の blob SHA (= GitHub API が tree / contents で返す `sha`)。
 *
 * `sha1("blob <バイト長>\0<内容>")`。ローカルのファイルから計算した値が
 * GitHub 側の blob SHA と一致するので、取り込み時に `Article.githubSha` として
 * 保存しておけば、push 時にネットワーク越しに内容を取らなくても
 * 「取り込んだ時点から上流が変わっていないか」を tree 1 回で判定できる。
 *
 * 改行コードや BOM を正規化しない (git も正規化しない)。ファイルをそのまま渡すこと。
 */
export function gitBlobSha(content: string | Buffer): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1")
    .update(`blob ${buf.byteLength}\0`)
    .update(buf)
    .digest("hex");
}
