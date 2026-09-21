export default function Loading() {
  return (
    <div className="max-w-3xl mx-auto animate-pulse">
      <div className="h-3 w-16 bg-slate-100 rounded" />
      <div className="h-7 w-64 bg-slate-200 rounded mt-2 mb-2" />
      <div className="h-3 w-80 max-w-full bg-slate-100 rounded mb-6" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
          <div className="h-4 w-24 bg-slate-200 rounded mb-3" />
          <div className="h-3 w-3/4 bg-slate-100 rounded mb-2" />
          <div className="h-3 w-1/2 bg-slate-50 rounded" />
        </div>
      ))}
    </div>
  );
}
