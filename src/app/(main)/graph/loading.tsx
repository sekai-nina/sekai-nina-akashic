export default function Loading() {
  return (
    <div className="max-w-6xl mx-auto animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-32 bg-slate-200 rounded" />
      </div>
      <div className="bg-white border border-slate-200 rounded-lg" style={{ height: "70vh" }}>
        <div className="flex h-full items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
        </div>
      </div>
    </div>
  );
}
