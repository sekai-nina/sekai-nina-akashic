"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ScanFace } from "lucide-react";
import type { AssetFace, FaceDecision } from "@/lib/domain/face-review";
import { submitFaceReview } from "../../faces/actions";
import { FaceCrop } from "../../faces/face-review-board";

const STATUS_LABELS: Record<AssetFace["status"], string> = {
  auto: "自動",
  pending: "確認待ち",
  confirmed: "確定",
  rejected: "却下",
};
const STATUS_STYLES: Record<AssetFace["status"], string> = {
  auto: "bg-sky-50 text-sky-700",
  pending: "bg-amber-50 text-amber-700",
  confirmed: "bg-emerald-50 text-emerald-700",
  rejected: "bg-slate-100 text-slate-500",
};

/** 写っている人として表示する名前 */
function shownName(f: AssetFace): string {
  if (f.status === "auto" || f.status === "pending") return f.predictedName ?? "?";
  if (f.confirmedName) return f.confirmedName;
  return f.status === "confirmed" ? "メンバー以外" : `${f.predictedName ?? "?"}ではない`;
}

/**
 * アセット詳細の「写っている人」(#409)。顔認識の顔を切り抜きで並べ、その場で直せる。
 * 動画 (トーク) の顔は、サムネイルが別のコマなので切り抜かず、何秒目かだけを出す
 */
export function FacesPanel({
  faces,
  imageUrl,
  members,
  editable,
}: {
  faces: AssetFace[];
  imageUrl: string | null;
  members: { id: string; name: string; generation: number }[];
  editable: boolean;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (f: AssetFace, value: string) => {
    let decision: FaceDecision;
    if (value === "confirm") decision = { faceId: f.id, action: "confirm" };
    else if (value === "reject") decision = { faceId: f.id, action: "reject" };
    else if (value === "nonmember") decision = { faceId: f.id, action: "nonmember" };
    else decision = { faceId: f.id, action: "other", entityId: value };
    setError(null);
    startTransition(async () => {
      const r = await submitFaceReview([decision]);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5 mb-3">
        <ScanFace className="h-4 w-4 text-sky-600" />
        写っている人 (顔認識)
      </h3>
      <ul className="space-y-2">
        {faces.map((f) => (
          <li key={f.id} className="flex items-center gap-2">
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded bg-slate-900">
              {f.frameSec == null ? (
                <FaceCrop src={imageUrl} bbox={f.bbox} size={56} />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-xs text-white">{f.frameSec.toFixed(1)}秒</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-slate-800 truncate">{shownName(f)}</div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <span className={`rounded px-1 ${STATUS_STYLES[f.status]}`}>{STATUS_LABELS[f.status]}</span>
                {f.similarity != null && <span>{f.similarity.toFixed(2)}</span>}
              </div>
              {editable && (
                <select
                  value=""
                  disabled={busy}
                  onChange={(e) => e.target.value && decide(f, e.target.value)}
                  className="mt-1 w-full rounded border border-slate-200 bg-white text-xs text-slate-700"
                  aria-label="この顔を直す"
                >
                  <option value="">直す…</option>
                  {f.predictedEntityId && <option value="confirm">{f.predictedName}で確定</option>}
                  {f.predictedEntityId && <option value="reject">{f.predictedName}ではない</option>}
                  <option value="nonmember">メンバー以外・顔ではない</option>
                  {members
                    .filter((m) => m.id !== f.predictedEntityId)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.generation}期 {m.name}
                      </option>
                    ))}
                </select>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
      <Link href="/faces" className="mt-3 inline-block text-xs text-sky-700 hover:underline">
        顔の確認へ →
      </Link>
    </div>
  );
}
