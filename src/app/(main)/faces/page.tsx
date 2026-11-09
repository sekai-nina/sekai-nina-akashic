import Link from "next/link";
import { notFound } from "next/navigation";
import { ScanFace } from "lucide-react";
import { auth } from "@/lib/auth";
import { getCachedEntityList } from "@/lib/cache";
import { countReviewFacesByEntity, listReviewFaces, REVIEW_PAGE_SIZE, type ReviewMode } from "@/lib/domain/face-review";
import { NINA_ENTITY_ID } from "@/lib/nina";
import { FaceReviewBoard } from "./face-review-board";
import { MemberSelect } from "./member-select";
import type { ClearanceLevel } from "@prisma/client";

/**
 * 顔の確認 (#409)。顔認識が自動で付けられなかった顔 (確認待ち) と、自動で付いた顔を人が確定・却下する。
 * 既定は坂井新奈と推定された確認待ちの顔を、似ている順に 40 個ずつ。
 * 人が確定した顔は、ワーカーの参照 (次からの判定の手本) になる。
 */
export default async function FacesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await auth();
  if (!session?.user) notFound();
  const canEdit = ["admin", "member"].includes(session.user.role);
  const params = await searchParams;
  const mode: ReviewMode = params.mode === "auto" ? "auto" : "pending";
  const entityId = params.entity === "all" ? null : params.entity || NINA_ENTITY_ID;
  const page = Math.max(1, Number(params.page) || 1);

  const [entities, counts, { faces, total }] = await Promise.all([
    getCachedEntityList(session.user.clearance as ClearanceLevel),
    countReviewFacesByEntity(session.user.clearance, mode),
    listReviewFaces(session.user.clearance, mode, entityId, page),
  ]);
  // メンバー = 期のある人物 (卒業生を含む)
  const members = entities
    .filter((e) => e.type === "person" && e.generation != null)
    .sort((a, b) => (a.generation ?? 0) - (b.generation ?? 0) || (a.reading ?? a.canonicalName).localeCompare(b.reading ?? b.canonicalName, "ja"))
    .map((e) => ({ id: e.id, name: e.canonicalName, generation: e.generation as number }));
  const nameOf = new Map(members.map((m) => [m.id, m.name]));
  const allCount = [...counts.values()].reduce((a, b) => a + b, 0);
  const href = (p: Record<string, string>) => `/faces?${new URLSearchParams({ mode, entity: entityId ?? "all", ...p })}`;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <ScanFace className="h-6 w-6 text-sky-600" />
          顔の確認
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          顔認識の結果を人が確かめます。違う顔だけクリックで外し、残りをまとめて確定します。確定した顔は次からの判定の手本になります。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
          {(
            [
              ["pending", "確認待ち"],
              ["auto", "自動で付いた顔"],
            ] as const
          ).map(([m, label]) => (
            <Link
              key={m}
              href={`/faces?${new URLSearchParams({ mode: m, entity: entityId ?? "all" })}`}
              className={`px-3 py-1.5 rounded-md ${mode === m ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {label}
            </Link>
          ))}
        </div>
        <MemberSelect
          mode={mode}
          value={entityId ?? "all"}
          options={[
            { id: "all", label: `全員 (${allCount.toLocaleString()})` },
            ...members.map((m) => ({ id: m.id, label: `${m.generation}期 ${m.name} (${(counts.get(m.id) ?? 0).toLocaleString()})` })),
          ]}
        />
        <span className="text-sm text-slate-500">
          {mode === "pending" ? "似ている順" : "似ていない順 (間違いが多そうな順)"}・{total.toLocaleString()} 顔
        </span>
      </div>

      {faces.length === 0 ? (
        <p className="text-sm text-slate-500 py-12 text-center">この条件の顔はありません。</p>
      ) : (
        <FaceReviewBoard
          key={`${mode}:${entityId}:${page}:${faces.map((f) => f.id).join(",")}`}
          faces={faces.map((f) => ({ ...f, predictedName: f.predictedEntityId ? nameOf.get(f.predictedEntityId) ?? "?" : "?" }))}
          members={members}
          mode={mode}
          canEdit={canEdit}
        />
      )}

      {total > REVIEW_PAGE_SIZE && (
        <div className="flex justify-between items-center mt-4 text-sm">
          {page > 1 ? <Link href={href({ page: String(page - 1) })} className="text-sky-700 hover:underline">← 前の {REVIEW_PAGE_SIZE} 顔</Link> : <span />}
          <span className="text-slate-500">
            {(page - 1) * REVIEW_PAGE_SIZE + 1}〜{Math.min(page * REVIEW_PAGE_SIZE, total)} / {total.toLocaleString()}
          </span>
          {page * REVIEW_PAGE_SIZE < total ? (
            <Link href={href({ page: String(page + 1) })} className="text-sky-700 hover:underline">飛ばして次の {REVIEW_PAGE_SIZE} 顔 →</Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
