export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse">
      <div className="flex items-center justify-between mb-6">
        <div className="h-7 w-32 bg-slate-200 rounded" />
      </div>
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-4 py-4 space-y-2">
            <div className="h-4 w-3/4 bg-slate-100 rounded" />
            <div className="h-3 w-1/2 bg-slate-50 rounded" />
            <div className="h-3 w-1/3 bg-slate-50 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
