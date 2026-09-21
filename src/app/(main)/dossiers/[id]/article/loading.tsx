export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 animate-pulse">
      <div className="h-4 w-24 bg-slate-100 rounded mb-4" />
      <div className="h-7 w-64 bg-slate-200 rounded mb-2" />
      <div className="h-4 w-40 bg-slate-100 rounded mb-6" />
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="h-4 w-32 bg-slate-100 rounded" />
        <div className="h-8 w-full bg-slate-50 rounded" />
        <div className="h-8 w-2/3 bg-slate-50 rounded" />
      </div>
    </div>
  );
}
