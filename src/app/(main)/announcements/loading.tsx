export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto animate-pulse">
      <div className="flex items-center justify-between mb-6">
        <div className="h-7 w-32 bg-slate-200 rounded" />
        <div className="h-8 w-24 bg-slate-200 rounded" />
      </div>
      <div className="bg-slate-100 rounded-lg h-64" />
    </div>
  );
}
