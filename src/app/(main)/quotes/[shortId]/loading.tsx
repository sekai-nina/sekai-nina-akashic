export default function Loading() {
  return (
    <div className="max-w-3xl mx-auto animate-pulse">
      <div className="h-3 w-16 bg-slate-100 rounded" />
      <div className="mt-3 h-6 w-64 bg-slate-200 rounded" />
      <div className="mt-2 h-3 w-40 bg-slate-100 rounded" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 bg-white border border-slate-200 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
