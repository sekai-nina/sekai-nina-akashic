export default function Loading() {
  return <div className="mx-auto max-w-6xl animate-pulse"><div className="h-56 rounded-2xl bg-sky-100" /><div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((n) => <div key={n} className="overflow-hidden rounded-xl border border-slate-200"><div className="aspect-video bg-slate-200" /><div className="space-y-2 p-3"><div className="h-4 w-3/4 rounded bg-slate-200" /><div className="h-3 w-1/3 rounded bg-slate-100" /></div></div>)}</div></div>;
}
