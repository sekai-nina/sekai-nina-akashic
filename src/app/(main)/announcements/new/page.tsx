import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Megaphone } from "lucide-react";
import { toJstDateTimeLocal } from "@/lib/utils";
import { AnnouncementForm } from "../announcement-form";
import { createAnnouncementAction } from "../actions";

/** 新規作成。既定は「今すぐ公開」(書く場面のほとんどは出したい時) */
export default async function NewAnnouncementPage() {
  const session = await auth();
  if (!session?.user) notFound();
  if (!["admin", "member"].includes(session.user.role)) notFound();

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          href="/announcements"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          お知らせ一覧に戻る
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Megaphone className="h-6 w-6 text-green-600" />
          お知らせを書く
        </h1>
        <p className="text-slate-500 text-sm mt-1">見出し 1 行で伝わるように。本文は補足があるときだけ</p>
      </div>

      <AnnouncementForm
        action={createAnnouncementAction}
        initial={{
          title: "",
          body: "",
          kind: "feature",
          url: "",
          published: true,
          publishedAt: toJstDateTimeLocal(new Date()),
        }}
        submitLabel="保存する"
        pendingLabel="保存中..."
      />
    </div>
  );
}
