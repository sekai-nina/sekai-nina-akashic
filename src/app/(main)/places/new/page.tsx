import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, MapPin } from "lucide-react";
import { NewPlaceForm } from "./new-place-form";

export default async function NewPlacePage() {
  const session = await auth();
  if (!session?.user) notFound();
  if (!["admin", "member"].includes(session.user.role)) notFound();

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <Link
          href="/places"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          聖地一覧に戻る
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <MapPin className="h-6 w-6 text-green-600" />
          聖地を登録
        </h1>
      </div>

      <NewPlaceForm />
    </div>
  );
}
