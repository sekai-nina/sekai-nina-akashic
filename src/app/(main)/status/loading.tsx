export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-32 bg-slate-200 rounded" />
        <div className="h-4 w-96 max-w-full bg-slate-100 rounded" />
      </div>
      <div className="h-12 w-full bg-slate-100 rounded-lg mb-6" />
      {Array.from({ length: 3 }).map((_, g) => (
        <div key={g} className="mb-6">
          <div className="h-4 w-16 bg-slate-200 rounded mb-2" />
          <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full bg-slate-200" />
                <div className="h-4 w-32 bg-slate-100 rounded" />
                <div className="h-3 w-48 bg-slate-50 rounded" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
