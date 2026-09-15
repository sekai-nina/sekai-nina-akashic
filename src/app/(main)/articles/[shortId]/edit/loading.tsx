export default function Loading() {
  return (
    <div className="max-w-6xl mx-auto animate-pulse">
      <div className="h-4 w-32 bg-slate-100 rounded" />
      <div className="mt-3 mb-6 space-y-2">
        <div className="h-7 w-40 bg-slate-200 rounded" />
        <div className="h-4 w-72 bg-slate-100 rounded" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        <div>
          <div className="h-8 w-40 bg-slate-100 rounded mb-2" />
          <div className="h-[60vh] w-full bg-slate-100 rounded" />
        </div>
        <div className="space-y-4">
          <div className="h-96 w-full bg-slate-100 rounded-lg" />
          <div className="h-28 w-full bg-slate-100 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
