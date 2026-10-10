/**
 * `POST /articles/:shortId/append` と `POST /articles/:shortId/push` の入力 (#209)。
 *
 * Discord bot が一覧記事に 1 行足して、その記事だけを公開する経路。
 * それまで bot は公開リポジトリに直接 commit していて、Akashic の DB と食い違っていた。
 */
import { z } from "zod";
import { isValidDateString } from "@/lib/utils";

/**
 * 記事を GitHub (公開サイト) に push できるキー。write とは別に持たせる
 * (MCP / AI エージェント用の write キーに公開までさせない)
 */
export const ARTICLE_PUSH_PERMISSION = "article_push";

const dateString = z.string().refine(isValidDateString, "暦に実在する YYYY-MM-DD で指定してください");

export const ArticleAppendRequestSchema = z
  .object({
    updatedAt: z.string(),
    body: z.string(),
    articleUpdatedAt: dateString.nullable().optional(),
    sources: z
      .array(
        z
          .object({
            assetId: z.string().min(1).max(100).nullable().optional(),
            url: z.string().url().max(2000).nullable().optional(),
            label: z.string().max(500).nullable().optional(),
            date: dateString.nullable().optional(),
          })
          .strict()
          .refine((s) => !!s.assetId || !!s.url, "assetId か url のどちらかが必要です"),
      )
      .max(20)
      .optional(),
  })
  .strict();

export const ArticlePushRequestSchema = z
  .object({
    /** コミットメッセージの件名。省略で既定 */
    subject: z.string().max(200).nullable().optional(),
    /**
     * append の応答の `updatedAt`。渡すと、それ以降に記事が編集されていたら push しない
     * (bot が書いた直後に人が編集した内容を、bot の push でまとめて出さない)
     */
    expectedUpdatedAt: z.string().nullable().optional(),
  })
  .strict();
