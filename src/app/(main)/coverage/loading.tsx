export default function Loading() {
  return (
    <div className="max-w-full animate-pulse">
      <div className="mb-6">
        <div className="h-7 w-32 bg-slate-200 rounded" />
        <div className="h-4 w-96 max-w-full bg-slate-100 rounded mt-2" />
      </div>
      <div className="bg-slate-100 rounded-lg h-96" />
    </div>
  );
}
