export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 animate-pulse">
      <div className="h-4 w-16 bg-slate-100 rounded mb-3" />
      <div className="h-6 w-32 bg-slate-200 rounded mb-2" />
      <div className="h-4 w-56 bg-slate-100 rounded mb-6" />
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="h-3 w-24 bg-slate-100 rounded" />
        <div className="h-8 w-64 bg-slate-50 rounded" />
      </div>
      <div className="mt-4 bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="h-3 w-16 bg-slate-100 rounded" />
        <div className="h-8 w-40 bg-slate-50 rounded" />
        <div className="h-24 w-full bg-slate-50 rounded" />
      </div>
    </div>
  );
}
