export default function Loading() {
  return (
    <div className="max-w-4xl animate-pulse">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-56 bg-slate-200 rounded" />
        <div className="h-4 w-96 max-w-full bg-slate-100 rounded" />
      </div>
      <div className="h-9 w-72 bg-slate-100 rounded mb-4" />
      <div className="h-[32rem] bg-white border border-slate-200 rounded-lg" />
    </div>
  );
}
