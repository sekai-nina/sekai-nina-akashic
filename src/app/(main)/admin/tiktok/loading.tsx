export default function Loading() {
  return (
    <div className="max-w-5xl animate-pulse">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-48 bg-slate-200 rounded" />
        <div className="h-4 w-96 max-w-full bg-slate-100 rounded" />
      </div>
      {/* bot の状態 */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-6 space-y-2">
        <div className="h-4 w-20 bg-slate-200 rounded" />
        <div className="h-4 w-72 max-w-full bg-slate-100 rounded" />
      </div>
      {/* 追加フォーム */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="h-4 w-32 bg-slate-200 rounded" />
        <div className="h-9 w-full bg-slate-100 rounded" />
      </div>
      {/* 対象と直近の動画 */}
      {Array.from({ length: 2 }).map((_, g) => (
        <div key={g} className="mt-6 border border-slate-200 rounded-lg divide-y divide-slate-100">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-4 py-3 flex items-center gap-3">
              <div className="h-4 w-40 bg-slate-100 rounded" />
              <div className="h-3 w-64 max-w-full bg-slate-50 rounded" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
