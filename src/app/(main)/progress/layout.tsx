import { MATERIAL_PROGRESS_LABELS as L } from "@/lib/utils";
import { ProgressTabs } from "./progress-tabs";

/**
 * 素材のクリップ進捗 (#233) と記事化の進捗 (#207) を並べる。
 * 収集の進捗 (`/coverage`) とは別物。
 */
export default function ProgressLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900">{L.title}</h1>
      <ProgressTabs />
      {children}
    </div>
  );
}
