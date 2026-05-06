import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getCachedEntities } from "@/lib/cache";
import { AnalysisClient } from "./analysis-client";

export default async function AnalysisPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const allEntities = await getCachedEntities();
  const entities = allEntities.map((e) => ({
    id: e.id,
    type: e.type,
    canonicalName: e.canonicalName,
  }));

  const ninaEntity = entities.find(
    (e) => e.type === "person" && e.canonicalName === "坂井新奈"
  );

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 mb-6">テキスト分析</h1>
      <AnalysisClient
        entities={entities}
        defaultPersonId={ninaEntity?.id}
      />
    </div>
  );
}
