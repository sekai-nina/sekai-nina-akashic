export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-24 bg-slate-200 rounded" />
        <div className="h-4 w-96 max-w-full bg-slate-100 rounded" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3 mb-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-40 bg-white border border-slate-200 rounded-lg" />
        ))}
      </div>
      <div className="h-32 bg-white border border-slate-200 rounded-lg mb-6" />
      <div className="h-48 bg-white border border-slate-200 rounded-lg" />
    </div>
  );
}
