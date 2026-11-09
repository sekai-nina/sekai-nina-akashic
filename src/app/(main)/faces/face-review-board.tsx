"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FaceDecision } from "@/lib/domain/face-review";
import { submitFaceReview } from "./actions";

type Face = {
  id: string;
  assetId: string;
  assetTitle: string;
  thumbnailUrl: string | null;
  bbox: [number, number, number, number];
  similarity: number | null;
  predictedEntityId: string | null;
  predictedName: string;
};
type Member = { id: string; name: string; generation: number };

/** 外した顔をどうするか。reject = 推定のメンバーではない (誰かは分からない) */
type Excluded = { action: "reject" } | { action: "nonmember" } | { action: "other"; entityId: string };

const TILE = 112;

/**
 * 顔の一覧 (#409)。違う顔だけクリックで外し、残りをまとめて確定する。
 * 外した顔は既定で「推定のメンバーではない」。その場で別のメンバー・メンバー以外を選べる
 */
export function FaceReviewBoard({
  faces,
  members,
  mode,
  canEdit,
}: {
  faces: Face[];
  members: Member[];
  mode: "pending" | "auto";
  canEdit: boolean;
}) {
  const router = useRouter();
  const [excluded, setExcluded] = useState<Map<string, Excluded>>(new Map());
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const toggle = (id: string) => {
    if (!canEdit) return;
    setExcluded((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, { action: "reject" });
      return next;
    });
  };
  const setChoice = (id: string, choice: Excluded) => setExcluded((prev) => new Map(prev).set(id, choice));

  const names = [...new Set(faces.map((f) => f.predictedName))];
  const restCount = faces.length - excluded.size;
  const label = names.length === 1 ? names[0] : "それぞれの推定どおり";

  const submit = () => {
    const decisions: FaceDecision[] = faces.map((f) => {
      const ex = excluded.get(f.id);
      if (!ex) return { faceId: f.id, action: "confirm" };
      return ex.action === "other" ? { faceId: f.id, action: "other", entityId: ex.entityId } : { faceId: f.id, action: ex.action };
    });
    setMessage(null);
    startTransition(async () => {
      const r = await submitFaceReview(decisions);
      if (!r.ok) {
        setMessage(`保存できませんでした: ${r.error}`);
        return;
      }
      setMessage(`${r.result.updated} 顔を保存しました (タグ +${r.result.tagsAdded} / -${r.result.tagsRemoved})`);
      router.refresh();
    });
  };

  return (
    <div>
      <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(112px,1fr))]">
        {faces.map((f) => {
          const ex = excluded.get(f.id);
          return (
            <div key={f.id} className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => toggle(f.id)}
                disabled={!canEdit}
                className={`relative rounded-lg overflow-hidden border-2 ${ex ? "border-rose-500" : "border-transparent"} bg-slate-900`}
                style={{ width: TILE, height: TILE }}
                title={`${f.assetTitle}\n推定: ${f.predictedName} (${f.similarity?.toFixed(3) ?? "-"})`}
              >
                <FaceCrop src={f.thumbnailUrl} bbox={f.bbox} />
                <span className="absolute left-1 bottom-1 rounded bg-black/60 px-1 text-[11px] text-white">
                  {names.length > 1 ? `${f.predictedName} ` : ""}
                  {f.similarity?.toFixed(2) ?? "-"}
                </span>
                {ex && (
                  <span className="absolute inset-0 flex items-center justify-center bg-rose-900/40">
                    <X className="h-10 w-10 text-white" />
                  </span>
                )}
              </button>
              <div className="flex items-center justify-between text-[11px] text-slate-500" style={{ width: TILE }}>
                <a href={`/assets/${f.assetId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-sky-700">
                  画像 <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              {ex && (
                <select
                  value={ex.action === "other" ? ex.entityId : ex.action}
                  onChange={(e) => {
                    const v = e.target.value;
                    setChoice(f.id, v === "reject" || v === "nonmember" ? { action: v } : { action: "other", entityId: v });
                  }}
                  className="rounded border border-slate-200 bg-white text-[11px] text-slate-700"
                  style={{ width: TILE }}
                  aria-label="この顔は"
                >
                  <option value="reject">{f.predictedName}ではない</option>
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
          );
        })}
      </div>

      {canEdit ? (
        <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white/95 py-3">
          <Button onClick={submit} disabled={pending}>
            {pending ? "保存中…" : restCount > 0 ? `残り ${restCount} 顔を${label}と確定` : "外した顔を保存"}
            {excluded.size > 0 && restCount > 0 ? `・外した ${excluded.size} 顔も保存` : ""}
          </Button>
          <span className="text-xs text-slate-500">
            {mode === "auto" ? "自動で付いた顔を外すと、そのメンバーの顔タグも外れます。" : "外した顔は既定で「推定のメンバーではない」として保存します。"}
          </span>
          {message && <span className="text-sm text-slate-700">{message}</span>}
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-500">確認できるのはメンバー以上です。</p>
      )}
    </div>
  );
}

/** サムネイルから顔の周りを切り抜いて見せる。枠は画像の幅・高さに対する 0〜1 の割合 */
export function FaceCrop({ src, bbox, size: tile = TILE }: { src: string | null; bbox: [number, number, number, number]; size?: number }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  if (!src) return <span className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">画像なし</span>;
  const [x1, y1, x2, y2] = bbox;
  let style: React.CSSProperties = { opacity: 0 };
  if (size) {
    const side = Math.max((x2 - x1) * size.w, (y2 - y1) * size.h) * 1.6;
    const scale = tile / side;
    const cx = ((x1 + x2) / 2) * size.w * scale;
    const cy = ((y1 + y2) / 2) * size.h * scale;
    style = { width: size.w * scale, height: size.h * scale, left: tile / 2 - cx, top: tile / 2 - cy, maxWidth: "none" };
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      className="absolute"
      style={style}
      onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
    />
  );
}
