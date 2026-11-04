export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 animate-pulse">
      <div className="h-3 w-20 bg-slate-100 rounded" />
      <div className="mt-4 space-y-2">
        <div className="h-7 w-2/3 bg-slate-200 rounded" />
        <div className="h-4 w-1/2 bg-slate-100 rounded" />
      </div>
      <div className="mt-6 h-3 w-16 bg-slate-100 rounded" />
      <div className="mt-2 h-20 w-full bg-slate-50 border border-slate-200 rounded" />
      <div className="mt-6 h-3 w-24 bg-slate-100 rounded" />
      <div className="mt-2 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white border border-slate-200 rounded-lg p-3 sm:p-4 flex gap-3">
            <div className="shrink-0 w-24 sm:w-32 h-24 sm:h-32 bg-slate-100 rounded" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-3/4 bg-slate-100 rounded" />
              <div className="h-3 w-1/2 bg-slate-50 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
