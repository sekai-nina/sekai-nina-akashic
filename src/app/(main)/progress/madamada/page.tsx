import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listShowProgress } from "@/lib/domain/show-progress";
import { ShowList } from "../show-list";

/**
 * まだまだ！日向坂で会いましょう → 記事の進捗 (#208)。作りはひなあいと同じ。
 * 回番号はひなあい本編と同じ (#371 から) だが、出演一覧の記事も進捗も別に持つ。
 */
export default async function MadamadaProgressPage() {
  const session = await auth();
  if (!session?.user) notFound();
  const rows = await listShowProgress(session.user, "madamada");
  const editable = session.user.role === "admin" || session.user.role === "member";

  return (
    <>
      <p className="text-slate-500 text-sm mb-4">
        出演一覧の行は記事に足すと自動で済になる（Discord の 📤 はひなあい本編だけ）。出来事・属性記事を書き終えたら（書くことが無ければ）「見終わった」
      </p>
      <ShowList showKey="madamada" rows={rows} editable={editable} />
    </>
  );
}
