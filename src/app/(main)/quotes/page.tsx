import { redirect } from "next/navigation";

/** 一覧は記事化の進捗 (`/progress/blog`) に移った (#208)。名言の選択 (`/quotes/[shortId]`) はここに残る */
export default function QuotesPage() {
  redirect("/progress/blog");
}
