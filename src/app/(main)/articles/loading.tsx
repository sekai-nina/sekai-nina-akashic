export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-24 bg-slate-200 rounded" />
        <div className="h-4 w-64 bg-slate-100 rounded" />
      </div>
      <div className="h-10 w-full bg-slate-100 rounded-lg mb-4" />
      <div className="flex gap-2 mb-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-7 w-20 bg-slate-100 rounded-full" />
        ))}
      </div>
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="px-4 py-3 space-y-2">
            <div className="h-4 w-1/2 bg-slate-100 rounded" />
            <div className="h-3 w-2/3 bg-slate-50 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
