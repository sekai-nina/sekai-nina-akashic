import * as z from "zod";
import { $Enums } from "@prisma/client";

/**
 * 記事に出典 (pending の ArticleSource) を紐づける入力 (#110)。
 * REST `POST /articles/:shortId/sources` と MCP `akashic_add_article_source` で共有する。
 */
export const ArticleSourceAddSchema = z
  .object({
    assetId: z.string().min(1).describe("紐づけるアセットの ID"),
    label: z.string().max(500).optional().describe("出典の表示名 (例: 坂井新奈ブログ「17さい！」)。省略時は空"),
    excerpt: z.string().max(10_000).optional().describe("本文に反映したい抜粋"),
    excerptType: z.enum($Enums.TextType).optional().describe("抜粋の出どころ (AssetText の種類)"),
    excerptStart: z.number().int().min(0).optional().describe("抜粋の開始位置 (文字)"),
    excerptEnd: z.number().int().min(0).optional().describe("抜粋の終了位置 (文字)"),
  })
  .strict()
  .refine((v) => v.excerptStart === undefined || v.excerptEnd === undefined || v.excerptStart <= v.excerptEnd, {
    message: "excerptStart は excerptEnd 以下にしてください",
    path: ["excerptStart"],
  });

export type ArticleSourceAdd = z.infer<typeof ArticleSourceAddSchema>;
