import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isMaterialSourceKey } from "@/lib/clip-progress/material-items";
import { withClearance } from "@/lib/db";

/** 旧アイテムチェック画面へのリンクは、素材のクリップ進捗へ引き継ぐ。 */
export default async function LegacyCoverageItemsPage({
  params,
}: {
  params: Promise<{ sourceKey: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();
  const { sourceKey } = await params;
  const source = await withClearance(session.user.clearance, (tx) =>
    tx.dataSource.findUnique({ where: { key: sourceKey }, select: { key: true } })
  );
  if (!source) notFound();
  redirect(isMaterialSourceKey(source.key) ? `/progress/materials/${encodeURIComponent(source.key)}` : "/coverage");
}
