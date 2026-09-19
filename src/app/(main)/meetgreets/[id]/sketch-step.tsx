"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Check, Crop, Sparkles, X } from "lucide-react";
import type { SketchCandidate, SketchSourceAsset } from "@/lib/meetgreet/types";
import type { CropMap, CropRect } from "@/lib/meetgreet/crop";
import { maxReferencePhotos } from "@/lib/meetgreet/config";
import {
  generateSketchAction,
  saveSketchCropsAction,
  selectSketchAction,
  updateMeetGreetAction,
} from "../actions";
import { CropEditor } from "./crop-editor";
import { RefUpload } from "./ref-upload";

interface Props {
  meetGreetId: string;
  sources: SketchSourceAsset[];
  candidates: SketchCandidate[];
  selectedKey: string | null;
  extraPrompt: string;
  /** 参照写真の切り抜き枠 (#136) */
  crops: CropMap;
  /** 画風の見本。何を参考にしているかを見せる (#136) */
  styleReference: { url: string | null; isDefault: boolean; canEdit: boolean };
  /** その回だけの参考画像 (#159)。ドシエには入っていない */
  refs: { key: string; name: string; url: string }[];
}

/** 参照に使える 1 枚。ドシエの画像とアップロードした参考画像を同じ形で扱う */
interface PickItem {
  id: string;
  title: string;
  url: string | null;
  /** アップロードした参考画像か (#159)。切り抜きの元と消せるかが変わる */
  isRef: boolean;
}

const textareaCls =
  "w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm text-slate-900 outline-none focus:border-slate-400";

/**
 * スケッチの生成。ドシエの画像から参照を選び、候補を 2 枚作って 1 枚を確定する。
 * 気に入らなければ候補を 1 枚選んで修正指示を書き、それを元に作り直す。
 */
export function SketchStep({
  meetGreetId,
  sources,
  candidates,
  selectedKey,
  extraPrompt,
  crops,
  styleReference,
  refs,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [cropping, setCropping] = useState<PickItem | null>(null);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState(extraPrompt);
  const [revisionOf, setRevisionOf] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState("");

  // 作り直しでは直す候補で 1 枚使うので、写真の上限がその分下がる
  const limit = maxReferencePhotos(!!revisionOf);
  /** ドシエの画像 + アップロードした参考画像 (#159) */
  const items = useMemo<PickItem[]>(
    () => [
      ...sources.map((a) => ({ id: a.id, title: a.title, url: a.thumbnailUrl, isRef: false })),
      ...refs.map((r) => ({ id: r.key, title: r.name, url: r.url, isRef: true })),
    ],
    [sources, refs]
  );
  const sourceIds = useMemo(() => new Set(items.map((a) => a.id)), [items]);
  const refKeys = useMemo(() => new Set(refs.map((r) => r.key)), [refs]);
  // ドシエから外された画像が選ばれたままにならないようにする
  useEffect(() => {
    setPicked((s) => {
      const next = new Set([...s].filter((id) => sourceIds.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [sourceIds]);
  const overLimit = picked.size > limit;

  function togglePhoto(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function generate() {
    if (picked.size === 0) {
      setMsg("参照にする写真を選んでください");
      return;
    }
    if (overLimit) {
      setMsg(
        revisionOf
          ? `作り直しでは直す候補で 1 枚使うので、写真は ${limit} 枚までです`
          : `参照にできる写真は ${limit} 枚までです`
      );
      return;
    }
    setMsg("生成中… 1 分ほどかかります");
    startTransition(async () => {
      // 追加指示は生成の前に保存する。**失敗したら生成しない**
      // (サーバーは保存済みの指示を読むので、古い内容で 1 分かけて作ってしまう)
      if (extra !== extraPrompt) {
        const saved = await updateMeetGreetAction(meetGreetId, { extraSketchPrompt: extra }).catch(
          (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "保存に失敗しました" })
        );
        if (!saved.ok) {
          setMsg(`追加指示を保存できませんでした: ${saved.error}`);
          return;
        }
      }
      const res = await generateSketchAction(meetGreetId, {
        // アセットと参考画像は別々に渡す (サーバー側の検査が違う)
        assetIds: [...picked].filter((id) => !refKeys.has(id)),
        refKeys: [...picked].filter((id) => refKeys.has(id)),
        ...(revisionOf ? { revisionOf, revisionNote } : {}),
      }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(`${res.candidates.length} 枚できました`);
      setRevisionOf(null);
      setRevisionNote("");
      router.refresh();
    });
  }

  /** 切り抜き枠を保存する。`null` で枠を外す */
  function saveCrop(assetId: string, rect: CropRect | null) {
    setMsg(rect ? "切り抜きを保存中…" : "切り抜きを外しています…");
    startTransition(async () => {
      const res = await saveSketchCropsAction(meetGreetId, { [assetId]: rect }).catch(
        (e: unknown) => ({
          ok: false as const,
          error: e instanceof Error ? e.message : "通信に失敗しました",
        })
      );
      if (!res.ok) {
        setMsg(`エラー: ${res.error}`);
        return;
      }
      setMsg(rect ? "切り抜きを保存しました" : "切り抜きを外しました");
      setCropping(null);
      // 枠は生成のときにサーバーが読む。画面の表示も合わせ直す
      router.refresh();
    });
  }

  /** 参考画像を消す (#159)。R2 の実体ごと消える */
  function removeRef(key: string, name: string) {
    if (!confirm(`参考画像「${name}」を消しますか？`)) return;
    setMsg("消しています…");
    startTransition(async () => {
      const res = await fetch(
        `/api/meetgreets/${meetGreetId}/sketch-refs?key=${encodeURIComponent(key)}`,
        { method: "DELETE" }
      )
        .then((r) => r.json().then((j: { error?: string }) => ({ ok: r.ok, ...j })))
        .catch(() => ({ ok: false, error: "通信に失敗しました" }));
      if (!res.ok) {
        setMsg(`エラー: ${res.error ?? "消せませんでした"}`);
        return;
      }
      setPicked((p) => {
        const next = new Set(p);
        next.delete(key);
        return next;
      });
      setMsg("消しました");
      router.refresh();
    });
  }

  function select(key: string) {
    startTransition(async () => {
      const res = await selectSketchAction(meetGreetId, key).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : "通信に失敗しました",
      }));
      setMsg(res.ok ? "確定しました (記事のサムネになります)" : `エラー: ${res.error}`);
      if (res.ok) router.refresh();
    });
  }

  if (sources.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        ドシエに画像がありません。先に素材を反映してから生成してください。
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-xs font-medium text-slate-600">
            参照にする写真 ({picked.size} / 最大 {limit})
          </span>
          <span className="text-[11px] text-slate-500">その日の服装・髪型が分かるものを選ぶ</span>
        </div>
        <ul className="grid grid-cols-3 sm:grid-cols-5 gap-2" role="group" aria-label="参照にする写真">
          {items.map((a) => {
            const on = picked.has(a.id);
            const crop = crops[a.id];
            return (
              <li key={a.id} className="relative">
                <button
                  type="button"
                  onClick={() => togglePhoto(a.id)}
                  aria-pressed={on}
                  title={a.title}
                  className={
                    "block w-full rounded-md overflow-hidden border-2 transition-colors " +
                    (on ? "border-slate-900" : "border-transparent hover:border-slate-300")
                  }
                >
                  {a.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.url} alt={a.title} className="w-full h-20 object-cover bg-slate-100" />
                  ) : (
                    <span className="flex h-20 items-center justify-center bg-slate-100 text-[10px] text-slate-400 px-1 text-center">
                      {a.title}
                    </span>
                  )}
                </button>
                {a.url && (
                  <button
                    type="button"
                    onClick={() => setCropping(a)}
                    disabled={pending}
                    aria-label={`${a.title} を切り抜く`}
                    title={crop ? "切り抜き済み（押すと直せます）" : "切り抜く"}
                    className={
                      "absolute bottom-1 right-1 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] shadow-sm disabled:opacity-50 " +
                      (crop
                        ? "bg-emerald-600 text-white hover:bg-emerald-700"
                        : "bg-white/90 text-slate-600 hover:bg-white")
                    }
                  >
                    <Crop size={10} aria-hidden />
                    {crop ? "済" : ""}
                  </button>
                )}
                {a.isRef && (
                  <button
                    type="button"
                    onClick={() => removeRef(a.id, a.title)}
                    disabled={pending}
                    aria-label={`${a.title} を消す`}
                    title="この参考画像を消す"
                    className="absolute top-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded bg-white/90 text-slate-500 shadow-sm hover:bg-white hover:text-rose-600 disabled:opacity-50"
                  >
                    <X size={11} aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
        {styleReference.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={styleReference.url}
            alt="画風の見本"
            className="w-24 shrink-0 rounded border border-slate-200 bg-white"
          />
        ) : (
          <span className="flex h-16 w-24 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-[10px] text-slate-400">
            見本なし
          </span>
        )}
        <div className="min-w-0 text-xs text-slate-600">
          <p className="font-medium text-slate-700">画風の見本</p>
          <p className="mt-0.5 leading-relaxed">
            毎回この 1 枚を参考に描かせています（直前の結果を参照し続けると、コピーのコピーで
            画風がずれていくため）。
            {styleReference.isDefault ? "いまは既定の見本です。" : "差し替え済みの見本です。"}
          </p>
          {styleReference.canEdit && (
            <a href="/admin/sketch" className="mt-1 inline-block text-slate-500 hover:underline">
              見本とプロンプトを変える
            </a>
          )}
        </div>
      </div>

      <RefUpload meetGreetId={meetGreetId} />

      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1.5" htmlFor="mg-extra-prompt">
          この回の追加指示 (任意。どの髪型を中央にするか、配置の希望など)
        </label>
        <textarea
          id="mg-extra-prompt"
          className={textareaCls}
          rows={2}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="例: 中央はハーフアップ、左右に低めツインテールと帽子ありを置いてほしい"
        />
      </div>

      {revisionOf && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-800 mb-1.5">
            選んだ候補をもとに作り直します。直したいところを書いてください。
          </p>
          <textarea
            className={textareaCls}
            rows={2}
            value={revisionNote}
            onChange={(e) => setRevisionNote(e.target.value)}
            placeholder="例: 袖のふくらみをもっと大きく、中央の髪をもう少し明るく"
            aria-label="修正指示"
          />
          <button
            type="button"
            onClick={() => setRevisionOf(null)}
            className="mt-1.5 text-[11px] text-amber-700 hover:underline"
          >
            作り直しをやめる
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={generate}
          disabled={pending || picked.size === 0 || overLimit}
          className="inline-flex items-center gap-1 h-9 px-4 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          <Sparkles size={14} /> {revisionOf ? "作り直す" : "候補を生成"}
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>

      {cropping && (
        <CropEditor
          // **サムネイルではなく、サーバーが実際に切る画像**の上で枠を引く
          // (サムネイルは出どころで向きが変わり、座標系が揃わない)
          // 参考画像は R2 の実体 (保存時に正立にしてある)、ドシエの画像は
          // 「サーバーが実際に切る画像」を返す route。どちらも正立で座標系が揃う
          src={
            cropping.isRef
              ? (cropping.url ?? "")
              : `/api/meetgreets/${meetGreetId}/sketch-reference/${cropping.id}`
          }
          title={cropping.title}
          value={crops[cropping.id] ?? null}
          saving={pending}
          onSave={(rect) => saveCrop(cropping.id, rect)}
          onClear={() => saveCrop(cropping.id, null)}
          onClose={() => setCropping(null)}
        />
      )}

      {candidates.length > 0 && (
        <div>
          <span className="block text-xs font-medium text-slate-600 mb-1.5">
            候補（新しい順）
          </span>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {candidates.map((c, i) => {
              const isSelected = c.key === selectedKey;
              return (
                <li
                  key={c.key}
                  className={
                    "rounded-md border overflow-hidden " +
                    (isSelected ? "border-emerald-500 ring-1 ring-emerald-200" : "border-slate-200")
                  }
                >
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.url}
                      alt={`スケッチ候補 ${i + 1}${isSelected ? "（確定済み）" : ""}`}
                      className="w-full bg-white"
                    />
                  </a>
                  <div className="flex items-center gap-2 px-2 py-1.5 border-t border-slate-100">
                    {isSelected ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                        <Check size={12} /> 確定済み
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => select(c.key)}
                        disabled={pending}
                        className="text-xs text-slate-700 hover:text-slate-900 underline underline-offset-2 disabled:opacity-50"
                      >
                        これにする
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setRevisionOf(c.key);
                        setMsg(null);
                      }}
                      disabled={pending}
                      className="ml-auto text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
                    >
                      これを直す
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
