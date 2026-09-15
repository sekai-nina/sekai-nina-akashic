import * as z from "zod";
import { $Enums } from "@prisma/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { API_APPLY_MAX_CLASSIFICATION } from "@/lib/articles/apply";
import { ArticleEditPatchSchema, UpdatedAtSchema, hasPatchFields, parseUpdatedAt } from "@/lib/articles/patch";
import { toArticleDetail, toArticleSummary } from "@/lib/domain/article-api";
import { applyArticleSource, getArticleByShortId, listArticles, patchArticle } from "@/lib/domain/articles";
import { ARTICLE_TYPE_LABELS, describeEnum } from "@/lib/utils";
import { logMcpToolCall } from "./audit";
import { fail, ok, toToolError } from "./result";
import type { ToolContext } from "./tools";

/**
 * 記事 (世界新奈) の MCP ツール。REST `/api/v1/articles` と同じ domain 関数・同じ検証スキーマを使う。
 *
 * 想定する使い方は「pending の紐づけを見て、抜粋を本文に反映し、applied にする」:
 *   1. akashic_list_articles { hasPending: true } で対象を探す
 *   2. akashic_get_article で本文と sources (pending の excerpt) を読む
 *   3. akashic_apply_article_source で先に脚注番号を採る (公開判断。internal 以下のみ)
 *   4. 返った sourceNo で本文に ^[n] を書き、akashic_update_article { body, updatedAt } で保存する
 * 3 → 4 の順にするのは、途中で止まっても本文に宛先の無い脚注が残らないようにするため。
 *
 * 記事ページは cookie 依存の動的描画でサーバ側キャッシュが無く、ここからはブラウザの Router Cache も
 * 消せないので revalidate はしない (Server Action 側だけ)。監査ログは domain が `article.*` を書き、
 * ここでは `mcp.<tool>` を 1 本足す (規約)。
 */

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

const UPDATED_AT = UpdatedAtSchema.describe(
  "akashic_get_article / akashic_list_articles が返した updatedAt (ISO 8601)。一致しなければ衝突エラー",
);

const CONFLICT_MESSAGE =
  "記事が読んだ後に更新されています。返した updatedAt (現在の値) で再実行するか、akashic_get_article で読み直してください。";

export function registerArticleReadTools(server: McpServer, { user }: ToolContext) {
  server.registerTool(
    "akashic_list_articles",
    {
      title: "記事一覧",
      description:
        "公開サイト (世界新奈) の記事を一覧する。hasPending: true で「本文に未反映の紐づけ (pending) がある記事」だけに絞れる。" +
        "返る shortId は akashic_get_article / akashic_update_article にそのまま渡せる。",
      inputSchema: z.object({
        q: z.string().optional().describe("タイトル・本文の部分一致"),
        type: z.enum($Enums.ArticleType).optional().describe(describeEnum(ARTICLE_TYPE_LABELS)),
        hasPending: z.boolean().optional().describe("true で未反映の紐づけがある記事だけ"),
        dirty: z.boolean().optional().describe("true で未 push (GitHub と差分がある) の記事だけ"),
        includeDraft: z.boolean().optional().describe("既定 true。false で下書きを除く"),
        page: z.number().int().min(1).optional(),
        perPage: z.number().int().min(1).max(MAX_PER_PAGE).optional().describe(`既定 ${DEFAULT_PER_PAGE}`),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await listArticles({
        clearance: user.clearance,
        page: args.page,
        perPage: args.perPage ?? DEFAULT_PER_PAGE,
        type: args.type,
        q: args.q,
        includeDraft: args.includeDraft !== false,
        onlyPending: args.hasPending === true,
        pendingMaxClassification: API_APPLY_MAX_CLASSIFICATION,
        onlyDirty: args.dirty === true,
      });
      return ok({
        items: result.items.map(toArticleSummary),
        total: result.total,
        page: result.page,
        perPage: result.perPage,
      });
    }
  );

  server.registerTool(
    "akashic_get_article",
    {
      title: "記事の取得",
      description:
        "記事 1 本の本文・frontmatter・出典 (sources) を返す。sources の status=pending の行が「本文に未反映の紐づけ」で、" +
        "excerpt に根拠の抜粋が入っている。updatedAt は更新・反映の楽観ロックに使う。",
      inputSchema: z.object({ shortId: z.string().describe("記事の shortId") }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const article = await getArticleByShortId(args.shortId, user.clearance);
      if (!article) return fail("記事が見つかりません。", { shortId: args.shortId });
      return ok(toArticleDetail(article));
    }
  );
}

export function registerArticleWriteTools(server: McpServer, { user }: ToolContext) {
  server.registerTool(
    "akashic_update_article",
    {
      title: "記事の更新",
      description:
        "記事の本文・frontmatter を部分更新する。渡した項目だけ変わる (null で消す)。" +
        "更新すると次の push で公開リポジトリに出る。updatedAt は必ず直前に読んだ値を渡すこと。" +
        "本文に脚注を足すときは、先に akashic_apply_article_source で番号を採ってから ^[n] を書く。",
      inputSchema: ArticleEditPatchSchema.extend({
        shortId: z.string().describe("記事の shortId"),
        updatedAt: UPDATED_AT,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ shortId, updatedAt, ...patch }) => {
      const expected = parseUpdatedAt(updatedAt);
      if (!expected) return fail("updatedAt が日時として解釈できません (ISO 8601 で指定してください)。", { updatedAt });
      if (!hasPatchFields(patch)) return fail("更新する項目がありません。");

      try {
        const result = await patchArticle(shortId, expected, patch, { id: user.id, apiKeyId: user.apiKeyId });
        if (!result.ok) {
          switch (result.reason) {
            case "not_found":
              return fail("記事が見つかりません。", { shortId, reason: result.reason });
            case "invalid":
              return fail("入力に誤りがあります。", { reason: result.reason, fieldErrors: result.errors });
            case "conflict":
              return fail(CONFLICT_MESSAGE, { reason: result.reason, updatedAt: result.currentUpdatedAt });
          }
        }

        if (result.changed.length) {
          await logMcpToolCall({
            user,
            tool: "update_article",
            targetType: "Article",
            targetId: shortId,
            args: { changed: result.changed.join(",") },
          });
        }
        return ok({ shortId, changed: result.changed, updatedAt: result.updatedAt });
      } catch (err) {
        return toToolError(err, "記事の更新に失敗しました。");
      }
    }
  );

  server.registerTool(
    "akashic_apply_article_source",
    {
      title: "紐づけを反映済みにする",
      description:
        "pending の紐づけ (ArticleSource) を applied にし、脚注番号 sourceNo を採番して返す。" +
        "**公開を決める操作**: 次の push でこの出典の label / ref が公開リポジトリの frontmatter に載る。" +
        `機密レベルが ${API_APPLY_MAX_CLASSIFICATION} より上の出典はこのツールでは反映できない (画面から人間が行う)。` +
        "返った sourceNo で本文に ^[n] を書き、返った updatedAt を akashic_update_article に渡す。",
      inputSchema: z.object({
        shortId: z.string().describe("記事の shortId"),
        sourceId: z.string().describe("akashic_get_article の sources[].id (status=pending のもの)"),
        updatedAt: UPDATED_AT,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const expected = parseUpdatedAt(args.updatedAt);
      if (!expected) return fail("updatedAt が日時として解釈できません (ISO 8601 で指定してください)。", { updatedAt: args.updatedAt });

      try {
        const result = await applyArticleSource(
          {
            shortId: args.shortId,
            sourceId: args.sourceId,
            expectedUpdatedAt: expected,
            maxClassification: API_APPLY_MAX_CLASSIFICATION,
            actor: { id: user.id, apiKeyId: user.apiKeyId },
          },
          user.clearance
        );
        if (!result.ok) {
          const detail = { shortId: args.shortId, sourceId: args.sourceId, reason: result.reason };
          switch (result.reason) {
            case "not_found":
              return fail(
                "記事か紐づけが見つかりません。sourceId が akashic_get_article の sources[].id か確認してください。",
                detail
              );
            case "not_pending":
              return fail("この紐づけは pending ではありません (既に反映済みか、取り込み由来の出典です)。再試行しないでください。", detail);
            case "asset_missing":
              return fail("紐づけ先のアセットが削除されているため反映できません。再試行しないでください。", detail);
            case "above_limit":
              return fail(
                `機密レベルが ${API_APPLY_MAX_CLASSIFICATION} より上の出典は MCP からは反映できません。画面から人間が操作してください。`,
                detail
              );
            case "conflict":
              return fail(CONFLICT_MESSAGE, { ...detail, updatedAt: result.currentUpdatedAt });
          }
        }

        await logMcpToolCall({
          user,
          tool: "apply_article_source",
          targetType: "ArticleSource",
          targetId: args.sourceId,
          args: { shortId: args.shortId, sourceNo: result.sourceNo, previousClassification: result.previousClassification },
        });

        return ok({
          shortId: args.shortId,
          sourceId: args.sourceId,
          sourceNo: result.sourceNo,
          updatedAt: result.updatedAt,
          hint: `本文の該当箇所に ^[${result.sourceNo}] を書き、akashic_update_article に updatedAt=${result.updatedAt.toISOString()} を渡して保存してください。`,
        });
      } catch (err) {
        return toToolError(err, "紐づけの反映に失敗しました。");
      }
    }
  );
}
