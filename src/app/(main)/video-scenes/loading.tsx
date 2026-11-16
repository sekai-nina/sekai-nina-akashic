export default function Loading() {
  return <div className="mx-auto max-w-6xl animate-pulse space-y-5"><div className="h-8 w-56 rounded bg-slate-200" /><div className="aspect-video max-h-96 rounded-xl bg-slate-100" /><div className="grid grid-cols-2 gap-4">{[0, 1, 2, 3].map((n) => <div key={n} className="aspect-video rounded-xl bg-slate-100" />)}</div></div>;
}
