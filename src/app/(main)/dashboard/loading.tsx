export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse space-y-6">
      <div className="flex items-center justify-between">
        <div className="h-7 w-32 bg-slate-200 rounded" />
        <div className="h-8 w-24 bg-slate-200 rounded" />
      </div>
      <div className="grid md:grid-cols-5 gap-6">
        <div className="md:col-span-2 space-y-5">
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
            <div className="h-10 w-32 bg-slate-200 rounded" />
            <div className="h-3 w-20 bg-slate-100 rounded" />
            <div className="space-y-2 pt-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex justify-between">
                  <div className="h-4 w-20 bg-slate-100 rounded" />
                  <div className="h-4 w-12 bg-slate-100 rounded" />
                </div>
              ))}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="h-3 w-16 bg-slate-100 rounded mb-3" />
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1">
                  <div className="h-7 w-12 bg-slate-200 rounded" />
                  <div className="h-3 w-16 bg-slate-100 rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="md:col-span-3">
          <div className="bg-white border border-slate-200 rounded-lg">
            <div className="px-5 py-3 border-b border-slate-100">
              <div className="h-4 w-32 bg-slate-100 rounded" />
            </div>
            <div className="divide-y divide-slate-100">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="px-5 py-3 space-y-2">
                  <div className="h-4 w-3/4 bg-slate-100 rounded" />
                  <div className="h-3 w-1/3 bg-slate-50 rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
