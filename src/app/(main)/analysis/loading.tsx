export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse">
      <div className="h-7 w-40 bg-slate-200 rounded mb-6" />
      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 space-y-3">
        <div className="h-10 w-full bg-slate-100 rounded" />
        <div className="flex gap-2">
          <div className="h-8 w-24 bg-slate-100 rounded" />
          <div className="h-8 w-24 bg-slate-100 rounded" />
        </div>
      </div>
      <div className="bg-white border border-slate-200 rounded-lg p-6" style={{ height: "400px" }} />
    </div>
  );
}
