import { projectProgress } from "./firmware";
import { scheduledPeriods, type SchedulePeriod } from "./schedule";
import type { Development } from "./types";

export type DashboardView = "year" | "month";
type DateRange = { start: string; end: string };
type BusinessPeriod = DateRange & { type: "business"; label: "사업기간" };
export type TimelinePeriod = SchedulePeriod | BusinessPeriod;

export function localDate(date: Date) {
  return [String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

export function dayNumber(iso: string) {
  return Date.parse(iso + "T00:00:00Z") / 86_400_000;
}

export function dashboardCalendar(focus: Date, view: DashboardView, today: string) {
  const year = focus.getFullYear();
  const month = focus.getMonth();
  const annual = view === "year";
  const start = localDate(new Date(year, annual ? 0 : month, 1));
  const end = localDate(new Date(year, annual ? 12 : month + 1, 0));
  const firstDay = dayNumber(start);
  const numberOfDays = dayNumber(end) - firstDay + 1;
  const columns = Array.from({ length: annual ? 12 : numberOfDays }, (_, index) => {
    if (annual) {
      const first = localDate(new Date(year, index, 1));
      return { label: `${index + 1}월`, weekday: "", weekend: false, current: first.slice(0, 7) === today.slice(0, 7),
        days: new Date(year, index + 1, 0).getDate() };
    }
    const date = new Date(year, month, index + 1);
    const weekday = date.getDay();
    return { label: String(index + 1), weekday: ["일", "월", "화", "수", "목", "금", "토"][weekday],
      weekend: weekday === 0 || weekday === 6, current: localDate(date) === today, days: 1 };
  });
  const todayPosition = start <= today && today <= end ? (dayNumber(today) - firstDay + 0.5) / numberOfDays : undefined;
  return { view, start, end, firstDay, numberOfDays, columns, todayPosition };
}
export type DashboardCalendar = ReturnType<typeof dashboardCalendar>;

const datePattern = String.raw`(?:\d{4}|\d{2})[./-]\d{1,2}[./-]\d{1,2}`;
const rangePattern = new RegExp(String.raw`(?:^|\s)(${datePattern})?\s*[~～∼]\s*(${datePattern})?(?=\s|$)`);
const singleDatePattern = new RegExp(String.raw`(?:^|\s)(${datePattern})$`);

function normalizedDate(raw: string) {
  const [year, month, day] = raw.split(/[./-]/);
  const iso = [year.length === 2 ? "20" + year : year, month.padStart(2, "0"), day.padStart(2, "0")].join("-");
  const time = Date.parse(iso + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(iso + "T") ? iso : "";
}

// Imported workbooks store region-specific ranges in the 사업기간 section of the description.
// Dates in the free-form description and 비고 do not establish a project schedule.
function businessSchedule(summary: string) {
  const lines = summary.split(/\r?\n/).map(line => line.trim());
  const heading = lines.findLastIndex(line => /^사업기간\s*[:：]?$/.test(line));
  const source: string[] = [];
  const ranges: DateRange[] = [];
  for (let i = heading < 0 ? lines.length : heading + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^(?:비고|FW 진행사항|\[)/.test(line)) break;
    source.push(line);
    const match = rangePattern.exec(line);
    const first = match ? match[1] : singleDatePattern.exec(line)?.[1];
    const last = match ? match[2] : first;
    const start = first ? normalizedDate(first) : "";
    const end = last ? normalizedDate(last) : "";
    if ((!start && !end) || (first && !start) || (last && !end) || (start && end && start > end)) continue;
    // A lone end date is a known milestone. A start followed by "~" remains open.
    ranges.push({ start: start || end, end });
  }
  const periods: DateRange[] = [];
  for (const range of ranges.sort((a, b) => a.start.localeCompare(b.start))) {
    const previous = periods.at(-1);
    if (previous && (!previous.end || range.start <= previous.end)) {
      if (!range.end || (previous.end && range.end > previous.end)) previous.end = range.end;
    } else {
      periods.push(range);
    }
  }
  return { periods, text: source.join("\n") };
}

function firmwareBusinessPeriod(firmware: Development["firmware"]): BusinessPeriod | undefined {
  let start = "";
  let end = "";
  for (const fw of firmware) {
    if (fw.designStart && (!start || fw.designStart < start)) start = fw.designStart;
    if (fw.qaEnd > end) end = fw.qaEnd;
  }
  if (start && end && start <= end) return { type: "business", label: "사업기간", start, end };
}

export function dashboardEntry(item: Development) {
  const business = businessSchedule(item.summary);
  const stages = scheduledPeriods(item);
  const businessPeriod = firmwareBusinessPeriod(item.firmware);
  const timelinePeriods = businessPeriod ? [businessPeriod, ...stages] : stages;
  return { item, progress: projectProgress(item), stages, business, timelinePeriods,
    undated: !timelinePeriods.length && !business.periods.length };
}
export type DashboardEntry = ReturnType<typeof dashboardEntry>;

export function overlaps(period: DateRange, window: DateRange) {
  return period.start <= window.end && (!period.end || window.start <= period.end);
}
