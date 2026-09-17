export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto animate-pulse">
      <div className="flex items-center justify-between mb-6">
        <div className="space-y-2">
          <div className="h-7 w-24 bg-slate-200 rounded" />
          <div className="h-4 w-64 bg-slate-100 rounded" />
        </div>
        <div className="h-9 w-24 bg-slate-200 rounded" />
      </div>
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/2 bg-slate-100 rounded" />
              <div className="h-3 w-1/3 bg-slate-50 rounded" />
            </div>
            <div className="h-5 w-40 bg-slate-100 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
