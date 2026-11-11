export default function Loading() {
  return (
    <div className="max-w-6xl mx-auto animate-pulse">
      <div className="h-8 w-48 bg-slate-200 rounded mb-2" />
      <div className="h-4 w-96 max-w-full bg-slate-100 rounded mb-6" />
      <div className="h-9 w-80 max-w-full bg-slate-100 rounded mb-4" />
      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <div className="h-64 bg-slate-100 rounded-lg" />
        <div className="h-64 bg-slate-100 rounded-lg" />
      </div>
    </div>
  );
}
