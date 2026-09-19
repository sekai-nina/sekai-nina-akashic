export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto animate-pulse">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-40 bg-slate-200 rounded" />
        <div className="h-4 w-96 max-w-full bg-slate-100 rounded" />
      </div>
      <div className="h-10 w-64 bg-slate-100 rounded mb-8" />
      {Array.from({ length: 3 }).map((_, g) => (
        <div key={g} className="mb-8">
          <div className="h-4 w-20 bg-slate-200 rounded mb-3" />
          <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-3">
                <div className="h-4 w-48 bg-slate-100 rounded" />
                <div className="h-3 w-32 bg-slate-50 rounded" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
