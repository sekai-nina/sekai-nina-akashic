export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto animate-pulse">
      <div className="h-7 w-16 bg-slate-200 rounded mb-2" />
      <div className="h-4 w-96 max-w-full bg-slate-100 rounded mb-6" />
      <div className="h-8 w-full max-w-lg bg-slate-100 rounded mb-4" />
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-1/3 bg-slate-100 rounded" />
              <div className="h-3 w-1/2 bg-slate-50 rounded" />
            </div>
            <div className="h-4 w-12 bg-slate-100 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
