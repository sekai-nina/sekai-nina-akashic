/**
 * 366 日の埋まり具合。1 行 = 1 か月、1 マス = 1 日。埋まった日は濃く、今日は枠で示す。
 * 公開サイトの記念日ページにも同じ絵を出す (sekai-nina-site)。
 */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function DayGrid({ filled, today }: { filled: string[]; today: string }) {
  const set = new Set(filled);
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 overflow-x-auto">
      <div className="grid gap-y-1" style={{ gridTemplateColumns: "2.5rem repeat(31, minmax(0.55rem, 1fr))", columnGap: "2px" }}>
        {DAYS_IN_MONTH.map((days, mi) => {
          const month = mi + 1;
          const mm = String(month).padStart(2, "0");
          return [
            <span key={`l${month}`} className="text-xs text-slate-400 pr-1 leading-3">
              {month}月
            </span>,
            ...Array.from({ length: 31 }, (_, di) => {
              const day = di + 1;
              const key = `${mm}-${String(day).padStart(2, "0")}`;
              if (day > days) return <span key={key} />;
              const on = set.has(key);
              const isToday = key === today;
              return (
                <span
                  key={key}
                  title={`${month}/${day}${on ? "（記念日あり）" : ""}`}
                  className={`aspect-square rounded-[2px] ${on ? "bg-green-600" : "bg-slate-100"} ${isToday ? "ring-2 ring-offset-1 ring-slate-900" : ""}`}
                />
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}
