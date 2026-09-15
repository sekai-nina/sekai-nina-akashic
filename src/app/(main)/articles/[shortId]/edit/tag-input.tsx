"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** 候補の表示上限。既存タグは 158 種で、前方一致で絞れば十分 */
const MAX_SUGGESTIONS = 8;
/** 1 回の入力で複数タグを区切る文字 (半角カンマ・読点) */
const TAG_SEPARATOR = /[,、]/;

/**
 * タグのチップ入力。Enter / カンマ (`,` `、`) で確定、Backspace で末尾を消す。
 *
 * 送信は hidden input を 1 タグ 1 つ (`name` で指定) にして、Server Action 側で
 * `formData.getAll(name)` で受ける (JSON を挟まない)。
 * 候補は既存タグの前方一致。表記揺れ (「食レポ」と「食レポート」) を防ぐのが目的なので、
 * 候補は件数順のまま出す。候補はマウス (mousedown) で選ぶだけで、矢印キーの選択は付けていない
 * (listbox の ARIA を名乗ると支援技術がキー操作を期待するので付けない)。
 */
export function TagInput({
  id,
  name,
  value,
  onChange,
  options,
  disabled,
}: {
  /** `<label htmlFor>` に使う。内側のテキスト入力に付く */
  id: string;
  name: string;
  value: string[];
  onChange: (tags: string[]) => void;
  options: string[];
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);

  const suggestions = useMemo(() => {
    const q = draft.trim();
    if (!q) return [];
    return options.filter((t) => t.startsWith(q) && !value.includes(t)).slice(0, MAX_SUGGESTIONS);
  }, [draft, options, value]);

  /** 入力を確定してチップにする。既存と、同じ入力内の重複は落とす */
  function commit(raw: string) {
    const next = [...value];
    for (const t of raw.split(TAG_SEPARATOR)) {
      const tag = t.trim();
      if (tag && !next.includes(tag)) next.push(tag);
    }
    if (next.length !== value.length) onChange(next);
    setDraft("");
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  return (
    <div className="relative">
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 min-h-[38px] w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white",
          disabled && "bg-slate-50",
        )}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-xs"
          >
            {tag}
            <input type="hidden" name={name} value={tag} />
            <button
              type="button"
              aria-label={`${tag} を外す`}
              title="外す"
              disabled={disabled}
              onClick={() => remove(tag)}
              className="text-slate-400 hover:text-red-600 disabled:opacity-50"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={value.length ? "" : "タグを入力して Enter"}
          onChange={(e) => {
            // 貼り付けなどで区切り文字が混ざったら、その場で分割して確定する
            if (TAG_SEPARATOR.test(e.target.value)) commit(e.target.value);
            else setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            // IME 変換中の Enter は確定に使わせない。Safari は確定の Enter で isComposing が
            // false になるので keyCode 229 も見る (quick-create-modal と同じ)
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault(); // フォーム送信にしない
              commit(draft);
            } else if (e.key === "Backspace" && draft === "" && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // 候補のクリックは mousedown で先に確定しているので、blur 時の確定と競合しない
            setFocused(false);
            if (draft.trim()) commit(draft);
          }}
          className="flex-1 min-w-[8rem] outline-none bg-transparent"
        />
      </div>
      {focused && suggestions.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-56 overflow-auto bg-white border border-slate-200 rounded shadow-lg text-sm">
          {suggestions.map((t) => (
            <li
              key={t}
              // blur より先に走らせるため mousedown で確定する
              onMouseDown={(e) => {
                e.preventDefault();
                commit(t);
              }}
              className="px-3 py-1.5 cursor-pointer hover:bg-slate-50"
            >
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
