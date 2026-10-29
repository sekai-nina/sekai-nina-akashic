export default function Loading() {
  return (
    <div className="-mx-4 -mt-2 -mb-24 md:-m-6 h-[calc(100dvh-3rem)] md:h-dvh flex flex-col animate-pulse">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200">
        <div className="h-6 w-32 bg-slate-200 rounded" />
        <div className="h-8 w-24 bg-slate-200 rounded" />
      </div>
      <div className="flex-1 flex">
        <div className="hidden md:block w-[400px] border-r border-slate-200" />
        <div className="flex-1 bg-slate-100" />
      </div>
    </div>
  );
}
