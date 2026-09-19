export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse">
      <div className="mb-5 space-y-2">
        <div className="h-7 w-28 bg-slate-200 rounded" />
        <div className="h-4 w-80 bg-slate-100 rounded" />
      </div>
      <div className="h-10 w-full bg-slate-100 rounded-lg mb-3" />
      <div className="flex flex-wrap gap-2 mb-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-6 w-16 bg-slate-100 rounded-full" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-white border border-slate-200 rounded-lg p-4 space-y-2">
            <div className="h-3 w-full bg-slate-100 rounded" />
            <div className="h-3 w-5/6 bg-slate-100 rounded" />
            <div className="h-3 w-2/3 bg-slate-50 rounded" />
            <div className="h-3 w-1/2 bg-slate-50 rounded mt-3" />
          </div>
        ))}
      </div>
    </div>
  );
}
