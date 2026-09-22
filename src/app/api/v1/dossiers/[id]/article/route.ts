import { NextResponse } from "next/server";
import { ArticleTemplate } from "@prisma/client";
import * as z from "zod";
import { requireApiAuth } from "@/lib/api-auth";
import { articleGenerateErrorResponse, handleArticleGenerate } from "@/lib/domain/article-generate-route";
import {
  assertPlainDossier,
  getDossierForArticle,
  requireRenderableTemplate,
  setDossierTemplate,
  suggestTemplate,
} from "@/lib/domain/dossier-article";
import { getTemplate, selectableTemplates } from "@/lib/article-workflow/templates";
import { AiDraftSchema, ArticleGenerateSchema } from "@/lib/meetgreet/api";
import { formatZodError } from "@/lib/zod-error";

type Params = { params: Promise<{ id: string }> };

/** TikTok の短縮 URL の解決と、本文を書く Claude の呼び出し (#171) で外部に出る。数十秒かかることがある */
export const maxDuration = 300;

// ミーグリと同じ本体 + テンプレート / 追記先。restore の単独制約も同じ
const DossierArticleSchema = z
  .object({
    ...ArticleGenerateSchema.shape,
    /** テンプレートを決める (未設定のときは必須)。記事を作った後は変えられない */
    template: z.enum(ArticleTemplate).optional(),
    /** 追記する記事。ドシエに記事が 2 本以上あるときに要る */
    articleId: z.string().min(1).optional(),
    /** dryRun が返した AI の下書き (#171)。保存で差し込む。null は骨組みだけ。省略も骨組み */
    aiDraft: AiDraftSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => !(v.restore && (v.dryRun || v.exclude?.length || v.expectedDigest)), {
    message: "restore は単独で指定してください",
  })
  // 下書きは保存でしか使わない。dryRun に付けると黙って捨てて Claude をもう 1 回呼ぶことになる
  .refine((v) => !(v.aiDraft !== undefined && (v.dryRun || v.restore)), {
    message: "aiDraft は保存のときだけ指定してください (dryRun / restore とは併用できません)",
  });


/** テンプレートと紐づく記事を返す (何を送ればよいかを外部が知るため) */
export async function GET(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const dossier = await getDossierForArticle(auth, id);
  if (!dossier) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const def = dossier.articleTemplate ? getTemplate(dossier.articleTemplate) : null;
  return NextResponse.json({
    dossierId: dossier.id,
    container: dossier.container?.kind ?? null,
    template: dossier.articleTemplate,
    // 器のテンプレート (meetgreet / live) は器側で組むので「対応済み」
    templateSupported: def !== null,
    suggestedTemplate: suggestTemplate(dossier),
    selectableTemplates: selectableTemplates().map((t) => t.key),
    articles: dossier.articles.map((a) => ({
      id: a.id,
      shortId: a.shortId,
      title: a.title,
      type: a.type,
      draft: a.draft,
    })),
  });
}

/**
 * ドシエから記事を作る (#170)。`/api/v1/meetgreets/:id/article` と同じ形で、
 * 加えて `template` でテンプレートを決められる (未設定なら先に決める)。
 * 既存記事が紐づいていれば**増えた分だけ追記**、無ければ新規作成。
 * `dryRun: true` なら書き込まず、適用後の本文と増える行だけを返す。
 * `restore` だけを送ると、「今後足さない」の取り消しだけを行う (記事は触らない)。
 */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = DossierArticleSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }

  let dossier = await getDossierForArticle(auth, id);
  if (!dossier) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const wantsWrite = !parsed.data.dryRun && parsed.data.restore === undefined;
    if (parsed.data.template && parsed.data.template !== dossier.articleTemplate) {
      // **テンプレートを永続化するのは保存のときだけ。** dryRun / restore は「書き込まない」約束なので、
      // 見せる間だけメモリ上で当てる (設定できないテンプレートは同じ検査で 400 にする)
      if (wantsWrite) await setDossierTemplate(auth, dossier, parsed.data.template);
      else {
        assertPlainDossier(dossier);
        requireRenderableTemplate(parsed.data.template);
      }
      dossier = { ...dossier, articleTemplate: parsed.data.template };
    }
  } catch (e) {
    return articleGenerateErrorResponse(e);
  }
  return handleArticleGenerate(
    auth,
    { kind: "dossier", dossier, articleId: parsed.data.articleId ?? null },
    parsed.data
  );
}
