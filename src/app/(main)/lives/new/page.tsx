import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { withClearance } from "@/lib/db";
import { listSongKeys } from "@/lib/domain/songs";
import { REPORT_WINDOW_DAYS } from "@/lib/meetgreet/config";
import { NewLiveForm } from "./new-form";

export default async function NewLivePage() {
  const session = await auth();
  if (!session?.user) notFound();

  // 過去のライブは既に event エンティティがある (ライブ MV の取り込み等)。名前を打ち直して
  // 別のエンティティができないよう、選べるようにする。event は place ではないので
  // クリアランスの絞り (entityClearanceWhere) は要らないが、`_count.assets` は保護テーブル
  // AssetEntity の集計なので withClearance の中で引く (素の prisma だと無言で全部 0 件になる)
  const [events, songKeys] = await Promise.all([
    withClearance(session.user.clearance, (tx) =>
      tx.entity.findMany({
        where: { type: "event" },
        select: { id: true, canonicalName: true, _count: { select: { assets: true } } },
        orderBy: { canonicalName: "asc" },
      })
    ),
    listSongKeys(),
  ]);

  return (
    <div className="max-w-2xl mx-auto">
      <Link href="/lives" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ライブ一覧へ
      </Link>
      <h1 className="text-2xl font-bold text-slate-900 mt-2 mb-1">ライブを追加</h1>
      <p className="text-slate-500 text-sm mb-6">
        素材のドシエと X レポ収集 (初日〜最終日
        {REPORT_WINDOW_DAYS === 1 ? "の翌日" : `+${REPORT_WINDOW_DAYS} 日`}) を用意します。
        <strong>X の収集はここでは走りません。</strong>
        公演と曲は後からも直せます。
      </p>
      <NewLiveForm
        events={events.map((e) => ({ id: e.id, name: e.canonicalName, assetCount: e._count.assets }))}
        songKeys={songKeys}
      />
    </div>
  );
}
