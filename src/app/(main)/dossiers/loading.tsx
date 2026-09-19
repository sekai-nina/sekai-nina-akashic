export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-6 animate-pulse">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-28 bg-slate-200 rounded" />
        <div className="h-4 w-72 bg-slate-100 rounded" />
      </div>
      <div className="h-10 w-full bg-slate-100 rounded-lg mb-4" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="bg-white border border-slate-200 rounded-lg p-4 space-y-2">
            <div className="h-4 w-3/4 bg-slate-100 rounded" />
            <div className="h-3 w-1/2 bg-slate-50 rounded" />
            <div className="h-3 w-1/3 bg-slate-50 rounded mt-3" />
          </div>
        ))}
      </div>
    </div>
  );
}
