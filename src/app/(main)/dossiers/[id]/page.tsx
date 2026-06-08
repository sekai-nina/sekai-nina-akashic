import Link from "next/link";
import { ArrowLeft, MapPin } from "lucide-react";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDossier } from "@/lib/domain/dossiers";
import { canEditDossier, canManageDossier } from "@/lib/auth/dossier-permissions";
import { formatDate } from "@/lib/utils";
import { getR2PublicUrl } from "@/lib/r2";
import { exportDossierToYaml } from "@/lib/yaml/dossier-export";
import { DossierItemRow } from "./item-row";
import { DossierHeader } from "./dossier-header";
import { ExternalLinkForm } from "./external-link-form";
import { PlaceCandidateList } from "./place-candidate-list";
import { CopyYamlButton } from "./copy-yaml-button";
import { ExternalImageForm } from "./external-image-form";

interface DossierDetailProps {
  params: Promise<{ id: string }>;
}

export default async function DossierDetailPage({ params }: DossierDetailProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) notFound();

  const dossier = await getDossier(session.user, id);
  if (!dossier) notFound();

  const editable = canEditDossier(session.user, dossier);
  const manageable = canManageDossier(session.user, dossier);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <Link href="/dossiers" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
        <ArrowLeft size={14} /> ドシエ一覧へ
      </Link>

      <DossierHeader dossier={dossier} editable={editable} manageable={manageable} />

      <div className="mt-3 flex justify-end">
        <CopyYamlButton yaml={exportDossierToYaml(dossier)} />
      </div>

      <section className="mt-6">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1">
          <MapPin className="h-3.5 w-3.5" /> 場所候補
        </h2>
        <PlaceCandidateList
          dossierId={dossier.id}
          candidates={dossier.placeCandidates}
          editable={editable}
        />
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">アイテム ({dossier.items.length})</h2>
          {editable && (
            <div className="flex items-center gap-3">
              <ExternalLinkForm dossierId={dossier.id} />
              <ExternalImageForm dossierId={dossier.id} />
            </div>
          )}
        </div>

        {dossier.items.length === 0 ? (
          <div className="bg-white border border-dashed border-slate-300 rounded-lg p-6 text-center">
            <p className="text-sm text-slate-500">
              アイテムはまだありません。検索結果やアセット詳細から追加できます。
            </p>
            <Link href="/search" className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">
              検索ページへ →
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {dossier.items.map((item, idx) => (
              <li key={item.id}>
                <DossierItemRow
                  dossierId={dossier.id}
                  item={
                    item.kind === "external_image"
                      ? {
                          ...item,
                          externalImageUrl: item.externalImageKey
                            ? getR2PublicUrl(item.externalImageKey)
                            : null,
                          externalImageThumbnailUrl: item.externalImageThumbKey
                            ? getR2PublicUrl(item.externalImageThumbKey)
                            : null,
                        }
                      : item
                  }
                  editable={editable}
                  isFirst={idx === 0}
                  isLast={idx === dossier.items.length - 1}
                  orderedIds={dossier.items.map((i) => i.id)}
                  indexInList={idx}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8 text-[10px] text-slate-400">
        最終更新 {formatDate(dossier.updatedAt, true)}
      </p>
    </div>
  );
}
