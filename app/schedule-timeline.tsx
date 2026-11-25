import { useState, type ReactNode } from "react";
import { dayNumber, overlaps, type BusinessPeriod, type DashboardCalendar, type TimelinePeriod } from "@/lib/dashboard-schedule";
import { firmwarePeriods } from "@/lib/schedule";
import type { Development } from "@/lib/types";

function layoutPeriods(periods: TimelinePeriod[], calendar: DashboardCalendar) {
  const visible = periods.filter(period => overlaps(period, calendar)).map(period => ({
    period,
    first: Math.max(0, dayNumber(period.start) - calendar.firstDay),
    last: Math.min(calendar.numberOfDays - 1, dayNumber(period.end) - calendar.firstDay),
  })).sort((a, b) => a.first - b.first || a.last - b.last);

  const laneEnds: number[] = [];
  const bars = visible.map(bar => {
    const free = laneEnds.findIndex(end => end < bar.first);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = bar.last;
    return { ...bar, lane };
  });
  return { bars, laneCount: laneEnds.length };
}

function ChartRow({ calendar, periods, children, label, selected, onSelect }: {
  calendar: DashboardCalendar; periods: TimelinePeriod[]; children: ReactNode; label: string; selected?: boolean; onSelect?: () => void;
}) {
  const { bars, laneCount } = layoutPeriods(periods, calendar);
  const laneHeight = 21;
  const track = <>
    <span className="day-lines" aria-hidden="true">{calendar.columns.map(column =>
      <i key={column.label} className={column.weekend ? "weekend" : undefined} />)}</span>
    {calendar.todayPosition !== undefined &&
      <span aria-hidden="true" className="today-line" style={{ left: `${calendar.todayPosition * 100}%` }} />}
    {bars.map(({ period, first, last, lane }) => {
      const dates = period.start === period.end ? period.start : `${period.start} ~ ${period.end}`;
      const description = `${period.label} · ${dates}`;
      return <span key={period.type + period.start} className={`phase-bar ${period.type}`}
        style={{ left: `${first * 100 / calendar.numberOfDays}%`, width: `${(last - first + 1) * 100 / calendar.numberOfDays}%`,
          top: `calc(50% + ${(lane - (laneCount - 1) / 2) * laneHeight}px)` }}
        role="img" aria-label={description} title={description} />;
    })}
  </>;
  return <div className={`timeline-row ${onSelect ? "project-timeline" : "firmware-timeline"}${selected ? " selected" : ""}`}
    style={{ minHeight: Math.max(onSelect ? 66 : 58, 14 + laneCount * laneHeight) }}>
    {children}
    {onSelect
      ? <button type="button" className="timeline-track" tabIndex={-1} onClick={onSelect} aria-label={label + " 일정 및 상세 보기"}>{track}</button>
      : <div className="timeline-track" role="group" aria-label={label + " 일정"}>{track}</div>}
  </div>;
}

export function TimelineRow({ item, progress, businessPeriod, calendar, selected, onSelect }: {
  item: Development; progress: number; businessPeriod?: BusinessPeriod; calendar: DashboardCalendar; selected: boolean; onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = "firmware-schedules-" + item.id;
  return <>
    <ChartRow calendar={calendar} periods={businessPeriod ? [businessPeriod] : []} selected={selected} onSelect={onSelect} label={item.name}>
      <div className="task-info project-info">
        <button type="button" className="project-row-open" onClick={onSelect} aria-label={item.name + " 상세 보기"}>
          <span className="task-title"><strong title={item.name}>{item.name}</strong>
            <small>{[item.code, item.customer, item.region].filter(Boolean).join(" · ")}</small></span>
          <span className="task-meta">
            <span className="mini-avatars">{item.assignees.slice(0, 3).map((name, i) =>
              <i key={name} style={{ zIndex: 3 - i }} title={name}>{name.slice(0, 1)}</i>)}</span>
            <span className="timeline-percent"><progress aria-label="공정률" value={progress} max={100} /><b>{progress}%</b></span>
          </span>
        </button>
        <button type="button" className="fw-disclosure" aria-expanded={expanded} aria-controls={detailId}
          aria-label={`${item.name} 개발 FW 일정 ${expanded ? "접기" : "펼치기"}`} onClick={() => setExpanded(!expanded)}>
          <span aria-hidden="true" />
        </button>
      </div>
    </ChartRow>
    <div id={detailId} hidden={!expanded}>
      {expanded && (item.firmware.length ? item.firmware.map((fw, index) => {
        const label = `FW ${index + 1}`;
        const dates = firmwarePeriods(fw);
        const name = [label, fw.region, fw.kind, fw.version].filter(Boolean).join(" · ");
        return <ChartRow key={fw.id} calendar={calendar} periods={dates} label={name}>
          <div className="task-info firmware-info">
            <div className="fw-timeline-name"><strong>{name}</strong><span>{fw.status}</span></div>
            <div className="fw-timeline-dates">{dates.length ? dates.map(period =>
              <span key={period.type} title={`${period.start} ~ ${period.end}`}>
                {period.label} {period.start.slice(5).replace("-", "/")}{period.end !== period.start && "–" + period.end.slice(5).replace("-", "/")}
              </span>) : "일정 미정"}</div>
          </div>
        </ChartRow>;
      }) : <p className="fw-timeline-empty">등록된 개발 FW가 없습니다.</p>)}
    </div>
  </>;
}
