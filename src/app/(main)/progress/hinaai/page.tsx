import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { listShowProgress } from "@/lib/domain/show-progress";
import { ShowList } from "../show-list";

/**
 * ひなあい → 記事の進捗 (#208)。
 * 1 回 = 1 行で、出演一覧の行 (記事から導出) と記事化 (人が「見終わった」を付ける) を追う。
 */
export default async function HinaaiProgressPage() {
  const session = await auth();
  if (!session?.user) notFound();
  const rows = await listShowProgress(session.user, "hinaai");
  const editable = session.user.role === "admin" || session.user.role === "member";

  return (
    <>
      <p className="text-slate-500 text-sm mb-4">
        出演一覧の行は「行を足す」か Discord の 📤 で足すと自動で済になる。出来事・属性記事を書き終えたら（書くことが無ければ）「見終わった」
      </p>
      <ShowList showKey="hinaai" rows={rows} editable={editable} canPublish={session.user.role === "admin"} />
    </>
  );
}
