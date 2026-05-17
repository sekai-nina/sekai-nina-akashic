export default function Loading() {
  return (
    <div className="max-w-6xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-32 bg-slate-200 rounded" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="aspect-square bg-slate-100 rounded" />
        ))}
      </div>
    </div>
  );
}
