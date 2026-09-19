export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto animate-pulse">
      <div className="h-3 w-28 bg-slate-100 rounded" />
      <div className="h-7 w-64 bg-slate-200 rounded mt-2 mb-2" />
      <div className="h-4 w-full max-w-xl bg-slate-100 rounded mb-6" />
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="w-4 h-4 bg-slate-200 rounded" />
            <div className="h-4 w-48 bg-slate-100 rounded" />
            <div className="h-3 w-32 bg-slate-50 rounded ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
