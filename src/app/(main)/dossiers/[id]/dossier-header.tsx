"use client";

import { useState, useTransition } from "react";
import { Lock, Eye, Pencil, Settings, Trash2, X } from "lucide-react";
import { updateDossierMetaAction, deleteDossierAction } from "../actions";

const CLASSIFICATION_LABEL: Record<string, string> = {
  internal: "一般",
  confidential: "限定",
  restricted: "極秘",
};

const CLASSIFICATION_BADGE: Record<string, string> = {
  internal: "bg-blue-100 text-blue-700",
  confidential: "bg-orange-100 text-orange-700",
  restricted: "bg-red-100 text-red-700",
};

interface DossierHeaderProps {
  dossier: {
    id: string;
    title: string;
    summary: string;
    classification: string;
    viewMode: string;
    editMode: string;
    owner: { id: string; name: string; avatarUrl: string | null };
  };
  editable: boolean;
  manageable: boolean;
}

export function DossierHeader({ dossier, editable, manageable }: DossierHeaderProps) {
  const [title, setTitle] = useState(dossier.title);
  const [summary, setSummary] = useState(dossier.summary);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [classification, setClassification] = useState(dossier.classification);
  const [viewMode, setViewMode] = useState(dossier.viewMode);
  const [editMode, setEditMode] = useState(dossier.editMode);
  const [isPending, startTransition] = useTransition();

  function persistTitle() {
    if (title === dossier.title) return;
    const fd = new FormData();
    fd.set("title", title);
    startTransition(() => updateDossierMetaAction(dossier.id, fd));
  }

  function persistSummary() {
    if (summary === dossier.summary) return;
    const fd = new FormData();
    fd.set("summary", summary);
    startTransition(() => updateDossierMetaAction(dossier.id, fd));
  }

  function handleDelete() {
    if (!confirm(`「${dossier.title}」を削除しますか？`)) return;
    startTransition(() => deleteDossierAction(dossier.id));
  }

  function persistSharing() {
    const fd = new FormData();
    fd.set("classification", classification);
    fd.set("viewMode", viewMode);
    fd.set("editMode", editMode);
    startTransition(async () => {
      await updateDossierMetaAction(dossier.id, fd);
      setSettingsOpen(false);
    });
  }

  return (
    <div className="mt-3 bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {editable ? (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={persistTitle}
              className="w-full text-xl font-bold tracking-tight text-slate-900 bg-transparent outline-none border-b border-transparent focus:border-indigo-300"
            />
          ) : (
            <h1 className="text-xl font-bold tracking-tight text-slate-900">{dossier.title}</h1>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${CLASSIFICATION_BADGE[dossier.classification] ?? "bg-slate-100 text-slate-600"}`}
          >
            {CLASSIFICATION_LABEL[dossier.classification] ?? dossier.classification}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            {dossier.viewMode === "private" ? <Lock className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {dossier.editMode === "clearance" && <Pencil className="h-3 w-3" />}
          </span>
          {manageable && (
            <>
              <button
                type="button"
                onClick={() => setSettingsOpen((v) => !v)}
                title="共有設定"
                className="text-slate-400 hover:text-slate-600"
              >
                <Settings className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isPending}
                title="削除"
                className="text-rose-400 hover:text-rose-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {manageable && settingsOpen && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-slate-600">共有設定</h3>
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">クリアランス</label>
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value)}
                className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
              >
                <option value="internal">一般</option>
                <option value="confidential">限定</option>
                <option value="restricted">極秘</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">閲覧</label>
              <select
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value)}
                className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
              >
                <option value="private">自分のみ</option>
                <option value="clearance">クリアランス以上</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">編集</label>
              <select
                value={editMode}
                onChange={(e) => setEditMode(e.target.value)}
                className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
              >
                <option value="private">自分のみ</option>
                <option value="clearance">クリアランス以上</option>
              </select>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-slate-400">
            「クリアランス以上」を選ぶと、設定したクリアランス以上のユーザー全員が閲覧/編集できます。
          </p>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={persistSharing}
              disabled={isPending}
              className="bg-indigo-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
      )}

      {editable ? (
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onBlur={persistSummary}
          rows={summary.split("\n").length + 1}
          placeholder="このドシエの概要を書く…"
          className="mt-3 w-full text-sm text-slate-700 bg-transparent outline-none placeholder:text-slate-400 resize-none"
        />
      ) : dossier.summary ? (
        <p className="mt-3 text-sm text-slate-700 whitespace-pre-wrap">{dossier.summary}</p>
      ) : null}

      <p className="mt-3 text-[11px] text-slate-400">
        作成者: {dossier.owner.name}
      </p>
    </div>
  );
}
