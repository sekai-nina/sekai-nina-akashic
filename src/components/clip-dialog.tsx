"use client";

import { useEffect, useState, useTransition, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Scissors } from "lucide-react";
import { createClipAction } from "@/app/(main)/clips/actions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * クリップ (#41) の入力フォーム。
 *
 * 入口は 2 つで、どちらも同じフォームを開く:
 * - アセット詳細ヘッダの「クリップ」ボタン (`ClipButton`): 空のフォーム。スマホでは本文を
 *   コピーして引用欄に貼る (位置はサーバが本文から探す)
 * - 本文の範囲選択フローター: 選択した文字列と本文内の位置を `draft` で受け取り、
 *   引用欄に入れた状態で開く (メモを足して保存。空のまま保存も可)
 *
 * メモか引用のどちらかは必須 (サーバでも弾く)。引用欄を書き換えたら位置は捨てる
 * (ズレた範囲を送らない。サーバが探し直す)。
 */

export interface ClipDraft {
  excerpt?: string;
  excerptType?: string;
  excerptStart?: number;
  excerptEnd?: number;
}

interface ClipDialogProps {
  assetId: string;
  /** 本文を持つアセットか。持たなければ引用欄を出さない (貼るものが無い) */
  hasTexts: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft?: ClipDraft;
  /** 保存に成功したら呼ぶ (ページの再取得はダイアログ側で行う) */
  onCreated?: () => void;
}

const NOTE_PLACEHOLDER = "なぜ気になったか、あとで何に使えそうか (任意)";

export function ClipDialog({ assetId, hasTexts, open, onOpenChange, draft, onCreated }: ClipDialogProps) {
  const router = useRouter();
  const [excerpt, setExcerpt] = useState(draft?.excerpt ?? "");
  const [note, setNote] = useState("");
  // 引用欄を書き換えたら位置は信用できない
  const [keepPosition, setKeepPosition] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ located: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  // 開くたびに draft から初期化する (同じ画面で何度も使う)。閉じたときも戻しておき、
  // 次に開いた最初の描画で前回の「クリップしました」が一瞬見えないようにする
  useEffect(() => {
    setExcerpt(open ? (draft?.excerpt ?? "") : "");
    setNote("");
    setKeepPosition(true);
    setError(null);
    setDone(null);
  }, [open, draft]);

  const canSubmit = (excerpt.trim() !== "" || note.trim() !== "") && !isPending;

  const submitOnCmdEnter = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
  };

  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const usePosition = keepPosition && draft?.excerptStart != null && draft?.excerptEnd != null;
      const result = await createClipAction({
        assetId,
        note,
        excerpt,
        excerptType: usePosition ? draft?.excerptType : undefined,
        excerptStart: usePosition ? draft?.excerptStart : undefined,
        excerptEnd: usePosition ? draft?.excerptEnd : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone({ located: result.located });
      // アセット詳細の「クリップ」セクションと本文のハイライトに反映する
      router.refresh();
      onCreated?.();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* data-picker-panel: 本文の範囲選択フローターが「自分の外のクリック」と誤認して
          選択を解除しないようにする (texts-section.tsx の isInsideFloater) */}
      <DialogContent data-picker-panel className="max-w-md mx-4 max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Scissors className="h-4 w-4 text-sky-600" />
            クリップ
          </DialogTitle>
        </DialogHeader>

        {done ? (
          <div className="space-y-3">
            <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              クリップしました
              {excerpt.trim() !== "" && !done.located && (
                <span className="block text-xs text-emerald-800/80 mt-1">
                  引用の位置は本文に見つからなかったので、文字列だけ保存しました (本文上のハイライトは出ません)
                </span>
              )}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Link
                href="/clips"
                className="text-sm text-indigo-600 hover:underline"
              >
                クリップ一覧を開く →
              </Link>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="space-y-3"
          >
            {hasTexts && (
              <label className="block">
                <span className="block text-xs text-slate-500 mb-1">
                  引用
                  {draft?.excerptStart != null && keepPosition && (
                    <span className="ml-1 text-sky-600">(本文の位置つき)</span>
                  )}
                </span>
                <textarea
                  value={excerpt}
                  onChange={(e) => {
                    setExcerpt(e.target.value);
                    setKeepPosition(false);
                  }}
                  onKeyDown={submitOnCmdEnter}
                  rows={4}
                  placeholder="本文からコピーして貼り付け (任意)。位置は本文から探します"
                  className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded resize-y"
                />
              </label>
            )}
            <label className="block">
              <span className="block text-xs text-slate-500 mb-1">メモ</span>
              <textarea
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={submitOnCmdEnter}
                rows={3}
                placeholder={NOTE_PLACEHOLDER}
                className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded resize-y"
              />
            </label>
            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1.5">{error}</p>
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-slate-400">
                {hasTexts ? "メモか引用のどちらかは必須" : "メモは必須"}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                >
                  {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  クリップする
                </button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** アセット詳細ヘッダの常設ボタン。押すと空の `ClipDialog` を開く。隣の「ドシエに追加 / 記事に紐づけ」と同じ寸法 */
export function ClipButton({ assetId, hasTexts }: { assetId: string; hasTexts: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="クリップ (記事未定のまま取っておく)"
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-sky-300 text-sky-700 hover:bg-sky-50 transition-colors"
      >
        <Scissors size={14} />
        <span>クリップ</span>
      </button>
      <ClipDialog assetId={assetId} hasTexts={hasTexts} open={open} onOpenChange={setOpen} />
    </>
  );
}
