export default function Loading() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-6 w-48 rounded bg-slate-100" />
      <div className="space-y-3 rounded-lg bg-slate-50 p-4">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-16 w-2/3 rounded-2xl bg-slate-100" />)}
      </div>
    </div>
  );
}
