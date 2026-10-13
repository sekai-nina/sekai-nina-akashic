import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listShowProgress } from "@/lib/domain/show-progress";
import { ShowList } from "../show-list";

/**
 * ひななり (日向坂になりましょう) → 記事の進捗 (#208)。作りはひなあいと同じ。
 * 番外編は本編と同じ回に数える (出演一覧の `1a` の行も本編の回の行として済にする)。
 */
export default async function HinanariProgressPage() {
  const session = await auth();
  if (!session?.user) notFound();
  const rows = await listShowProgress(session.user, "hinanari");
  const editable = session.user.role === "admin" || session.user.role === "member";

  return (
    <>
      <p className="text-slate-500 text-sm mb-4">
        出演一覧の行は「行を足す」で足すと自動で済になる。出来事・属性記事を書き終えたら（書くことが無ければ）「見終わった」
      </p>
      <ShowList showKey="hinanari" rows={rows} editable={editable} canPublish={session.user.role === "admin"} />
    </>
  );
}
