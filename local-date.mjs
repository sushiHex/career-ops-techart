/**
 * local-date.mjs: today's date as YYYY-MM-DD in the machine's LOCAL time zone.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, which in California is
 * already tomorrow from 5pm (PDT) or 4pm (PST). A scan run on the evening of
 * 2026-10-18 stamped its pipeline section, scan-history first-seen dates and the
 * tracker index as 2026-10-19, so "added today" and every recheck window measured
 * from first-seen were a day off for any evening run. Every human-facing date in
 * this repo (report filenames, eval-write --date, follow-up due dates) is local, so
 * the scanners now agree with them.
 */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
