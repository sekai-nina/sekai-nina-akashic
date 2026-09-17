export default function Loading() {
  return (
    <div className="max-w-2xl mx-auto animate-pulse">
      <div className="h-3 w-28 bg-slate-100 rounded" />
      <div className="h-7 w-48 bg-slate-200 rounded mt-2 mb-2" />
      <div className="h-4 w-full max-w-md bg-slate-100 rounded mb-6" />
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className="h-3 w-24 bg-slate-100 rounded mb-1.5" />
            <div className="h-9 w-full bg-slate-100 rounded" />
          </div>
        ))}
        <div className="h-9 w-24 bg-slate-200 rounded" />
      </div>
    </div>
  );
}
