"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import { ARTICLE_TYPE_LABELS } from "@/lib/utils";
import type { ArticleType, ClearanceLevel } from "@prisma/client";
import type { AnniversaryFormState } from "./actions";

export interface AnniversaryFormArticle {
  id: string;
  shortId: string;
  title: string;
  type: ArticleType | null;
}

export interface AnniversaryFormAsset {
  id: string;
  title: string;
  /** JST の YYYY-MM-DD */
  date: string | null;
}

export interface AnniversaryFormValues {
  date: string;
  title: string;
  description: string;
  sourceUrl: string;
  articleId: string;
  classification: ClearanceLevel;
}

interface Props {
  action: (prev: AnniversaryFormState, formData: FormData) => Promise<AnniversaryFormState>;
  articles: AnniversaryFormArticle[];
  /** 出典アセット。アセットページから来たときは埋まっている。外すと null で送る */
  asset: AnniversaryFormAsset | null;
  initial: AnniversaryFormValues;
  submitLabel: string;
  pendingLabel: string;
}

const fieldClass =
  "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500";

/** 登録 / 編集で共通のフォーム。エラーは Server Action の戻り値で出す (画面遷移しない) */
export function AnniversaryForm({ action, articles, asset, initial, submitLabel, pendingLabel }: Props) {
  const [state, formAction] = useActionState(action, null as AnniversaryFormState);
  const [linkedAsset, setLinkedAsset] = useState(asset);

  return (
    <form action={formAction} className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
      {state?.error && (
        <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">{state.error}</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            初めての日 <span className="text-red-500">*</span>
          </label>
          <input type="date" name="date" required defaultValue={initial.date} className={fieldClass} />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            呼び名 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="title"
            required
            maxLength={100}
            defaultValue={initial.title}
            placeholder="例: 初ブログの日"
            className={fieldClass}
          />
          <p className="text-xs text-slate-400 mt-1">公開サイトの「今日は〇〇の日」にそのまま出る</p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">何があったか</label>
        <textarea
          name="description"
          rows={3}
          maxLength={1000}
          defaultValue={initial.description}
          placeholder="例: 『一生一度の 坂井新奈』というタイトルでブログを初めて投稿した"
          className={fieldClass}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">出典アセット</label>
        {linkedAsset ? (
          <div className="flex items-center gap-2 border border-slate-200 rounded-lg px-3 py-2 text-sm">
            <input type="hidden" name="assetId" value={linkedAsset.id} />
            <Link href={`/assets/${linkedAsset.id}`} className="min-w-0 truncate text-green-700 hover:underline">
              {linkedAsset.title || "(無題)"}
            </Link>
            {linkedAsset.date && <span className="shrink-0 text-xs text-slate-400">{linkedAsset.date}</span>}
            <button
              type="button"
              onClick={() => setLinkedAsset(null)}
              className="ml-auto shrink-0 text-slate-400 hover:text-slate-700"
              aria-label="出典アセットを外す"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <>
            <input type="hidden" name="assetId" value="" />
            <p className="text-xs text-slate-400">
              アセットページの「記念日に登録」から来ると、そのアセットが出典として付く
            </p>
          </>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">出典 URL</label>
        <input
          type="url"
          name="sourceUrl"
          defaultValue={initial.sourceUrl}
          placeholder="https://www.hinatazaka46.com/..."
          className={fieldClass}
        />
        <p className="text-xs text-slate-400 mt-1">
          アセット化していない公式ページ等。アセットがあればそちらの URL が使われるので空でよい
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_10rem] gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">関連記事</label>
          <select name="articleId" defaultValue={initial.articleId} className={`${fieldClass} bg-white`}>
            <option value="">なし</option>
            {articles.map((a) => (
              <option key={a.id} value={a.id}>
                {a.type ? `[${ARTICLE_TYPE_LABELS[a.type]}] ` : ""}
                {a.title || a.shortId}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400 mt-1">公開サイトの記念日からのリンク先</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">クリアランス</label>
          <select name="classification" defaultValue={initial.classification} className={`${fieldClass} bg-white`}>
            <option value="internal">一般 (サイトに出す)</option>
            <option value="confidential">限定</option>
            <option value="restricted">極秘</option>
          </select>
        </div>
      </div>

      <div className="pt-2">
        <SubmitButton
          className="w-full px-4 py-2.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg justify-center"
          pendingText={pendingLabel}
        >
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}
