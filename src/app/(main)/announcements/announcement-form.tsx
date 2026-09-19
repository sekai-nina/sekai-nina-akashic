"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { ANNOUNCEMENT_KIND_LABELS } from "@/lib/utils";
import type { AnnouncementKind } from "@prisma/client";
import type { AnnouncementFormState } from "./actions";

export interface AnnouncementFormValues {
  title: string;
  body: string;
  kind: AnnouncementKind;
  url: string;
  published: boolean;
  /** datetime-local の JST 表記 "YYYY-MM-DDTHH:mm"。空なら保存時に今 */
  publishedAt: string;
}

interface Props {
  action: (prev: AnnouncementFormState, formData: FormData) => Promise<AnnouncementFormState>;
  initial: AnnouncementFormValues;
  submitLabel: string;
  pendingLabel: string;
}

const fieldClass =
  "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500";

const KIND_HINTS: Record<AnnouncementKind, string> = {
  feature: "例: 記念日ページを追加しました",
  article: "例: ミーグリの記事を 5 件追加しました",
  info: "例: 案内AIを一時停止しています",
};

/** 登録 / 編集で共通のフォーム。エラーは Server Action の戻り値で出す (画面遷移しない) */
export function AnnouncementForm({ action, initial, submitLabel, pendingLabel }: Props) {
  const [state, formAction] = useActionState(action, null as AnnouncementFormState);
  const [kind, setKind] = useState<AnnouncementKind>(initial.kind);
  const [published, setPublished] = useState(initial.published);

  return (
    <form action={formAction} className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
      {state?.error && (
        <p className="text-sm text-red-600 border border-red-200 bg-red-50 rounded px-3 py-2">{state.error}</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-[8rem_1fr] gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">種類</label>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as AnnouncementKind)}
            className={`${fieldClass} bg-white`}
          >
            {(Object.keys(ANNOUNCEMENT_KIND_LABELS) as AnnouncementKind[]).map((k) => (
              <option key={k} value={k}>
                {ANNOUNCEMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            見出し <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="title"
            required
            maxLength={120}
            defaultValue={initial.title}
            placeholder={KIND_HINTS[kind]}
            className={fieldClass}
          />
          <p className="text-xs text-slate-400 mt-1">トップの「お知らせ」にはこの一行だけ出る。文末は「〜しました」で揃える</p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">本文</label>
        <textarea
          name="body"
          rows={8}
          maxLength={5000}
          defaultValue={initial.body}
          placeholder={"Markdown。記事へのリンクは [[記事のタイトル]] で書ける\n\n例:\n- [[ひなあい初登場時の自己紹介]] を更新しました\n- 出典を 3 件追加"}
          className={`${fieldClass} font-mono leading-relaxed`}
        />
        <p className="text-xs text-slate-400 mt-1">
          空でもよい。/news では見出しの下にそのまま出る。描画は記事と同じ (保存後の詳細で確認できる)
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">リンク</label>
        <input
          type="text"
          name="url"
          defaultValue={initial.url}
          placeholder="/anniversaries または https://..."
          className={fieldClass}
        />
        <p className="text-xs text-slate-400 mt-1">
          「詳しく →」の飛び先。機能の追加ならそのページ、記事の更新なら記事一覧など。サイト内は / から
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 items-start border-t border-slate-100 pt-4">
        <label className="inline-flex items-center gap-2 text-sm text-slate-700 py-2">
          <input
            type="checkbox"
            name="published"
            checked={published}
            onChange={(e) => setPublished(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-green-600 focus:ring-green-500"
          />
          公開する
        </label>
        <div>
          <input
            type="datetime-local"
            name="publishedAt"
            defaultValue={initial.publishedAt}
            disabled={!published}
            className={`${fieldClass} disabled:bg-slate-50 disabled:text-slate-400`}
          />
          <p className="text-xs text-slate-400 mt-1">
            {published
              ? "公開日時 (JST)。空なら保存した時刻。過去にすると並びが下がる。サイトには数分で出る (再ビルド不要)"
              : "外すと下書き。サイトにも API にも出ない"}
          </p>
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
