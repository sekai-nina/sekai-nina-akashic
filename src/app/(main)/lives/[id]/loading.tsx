export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto animate-pulse">
      <div className="h-3 w-24 bg-slate-100 rounded mb-4" />
      <div className="h-7 w-72 bg-slate-200 rounded mb-2" />
      <div className="h-4 w-48 bg-slate-100 rounded mb-8" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
          <div className="h-4 w-32 bg-slate-200 rounded mb-3" />
          <div className="h-3 w-3/4 bg-slate-100 rounded mb-2" />
          <div className="h-3 w-1/2 bg-slate-50 rounded" />
        </div>
      ))}
    </div>
  );
}
