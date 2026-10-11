import { ProgressTabs } from "./progress-tabs";

/**
 * 記事化の進捗 (#207)。集めた素材を、どの反映先まで記事にしたかを素材の種類ごとに追う。
 * 収集の進捗 (`/coverage`) とは別物。
 */
export default function ProgressLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900">記事化の進捗</h1>
      <ProgressTabs />
      {children}
    </div>
  );
}
