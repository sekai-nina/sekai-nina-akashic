export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse">
      <div className="flex items-center justify-between mb-6">
        <div className="h-7 w-32 bg-slate-200 rounded" />
        <div className="h-8 w-24 bg-slate-200 rounded" />
      </div>
      <div className="space-y-6">
        {Array.from({ length: 3 }).map((_, gi) => (
          <div key={gi}>
            <div className="h-4 w-16 bg-slate-100 rounded mb-2" />
            <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center px-4 py-3">
                  <div className="h-4 w-1/3 bg-slate-100 rounded" />
                  <div className="ml-auto h-4 w-12 bg-slate-100 rounded" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
