import { useEffect, useState } from "react";

import { dateTime, duration, timeAgo } from "@/lib/format";

/** A shared 15-second tick, so every relative clock on the page moves together at one timer. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "3m ago", refreshing itself, with the absolute time on hover. */
export function RelativeTime({ iso, className, prefix }: { iso: string; className?: string; prefix?: string }) {
  const now = useNow();
  return (
    <time dateTime={iso} title={dateTime(iso)} className={className}>
      {prefix !== undefined ? `${prefix} ` : ""}
      {timeAgo(iso, now)}
    </time>
  );
}

/** The time elapsed since a start (until an end, when there is one). */
export function Elapsed({ from, to, className }: { from: string; to?: string | null; className?: string }) {
  const now = useNow();
  const end = to ? Date.parse(to) : now;
  return (
    <span className={className} title={to ? `${dateTime(from)} → ${dateTime(to)}` : `since ${dateTime(from)}`}>
      {duration(end - Date.parse(from))}
    </span>
  );
}
