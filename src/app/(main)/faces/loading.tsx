export default function Loading() {
  return (
    <div className="max-w-6xl mx-auto animate-pulse">
      <div className="mb-5 space-y-2">
        <div className="h-7 w-32 bg-slate-200 rounded" />
        <div className="h-4 w-96 bg-slate-100 rounded" />
      </div>
      <div className="h-10 w-full bg-slate-100 rounded-lg mb-4" />
      <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(112px,1fr))]">
        {Array.from({ length: 24 }).map((_, i) => (
          <div key={i} className="aspect-square bg-slate-100 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
