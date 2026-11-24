import { useState, type ReactNode } from "react";
import { projectProgress } from "@/lib/firmware";
import { firmwarePeriods, scheduledPeriods, type SchedulePeriod } from "@/lib/schedule";
import type { Development } from "@/lib/types";

type Calendar = { month: Date; daysCount: number; today: Date };

function layoutPeriods(periods: SchedulePeriod[], firstDate: string, lastDate: string) {
  const visible = periods.filter(p => p.start <= lastDate && firstDate <= p.end).map(period => ({
    period,
    first: Number((period.start < firstDate ? firstDate : period.start).slice(-2)),
    last: Number((period.end > lastDate ? lastDate : period.end).slice(-2)),
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

function ChartRow({ month, daysCount, today, periods, children, label, selected, onSelect }: Calendar & {
  periods: SchedulePeriod[]; children: ReactNode; label: string; selected?: boolean; onSelect?: () => void;
}) {
  const year = month.getFullYear();
  const m = month.getMonth();
  const prefix = `${year}-${String(m + 1).padStart(2, "0")}-`;
  const { bars, laneCount } = layoutPeriods(periods, prefix + "01", prefix + daysCount);
  const laneHeight = 21;
  const track = <>
    <span className="day-lines" aria-hidden="true">{Array.from({ length: daysCount }, (_, i) => {
      const weekday = new Date(year, m, i + 1).getDay();
      return <i key={i} className={weekday === 0 || weekday === 6 ? "weekend" : undefined} />;
    })}</span>
    {year === today.getFullYear() && m === today.getMonth() &&
      <span aria-hidden="true" className="today-line" style={{ left: `${(today.getDate() - 0.5) * 100 / daysCount}%` }} />}
    {bars.map(({ period, first, last, lane }) => {
      const dates = period.start === period.end ? period.start : `${period.start} ~ ${period.end}`;
      return <span key={period.type + period.start} className={`phase-bar ${period.type}`}
        style={{ left: `${(first - 1) * 100 / daysCount}%`, width: `${(last - first + 1) * 100 / daysCount}%`,
          top: `calc(50% + ${(lane - (laneCount - 1) / 2) * laneHeight}px)` }}
        title={`${period.label} · ${dates}`}>{period.label}</span>;
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

export function TimelineRow({ item, selected, onSelect, ...calendar }: Calendar & {
  item: Development; selected: boolean; onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = "firmware-schedules-" + item.id;
  const progress = projectProgress(item);
  return <>
    <ChartRow {...calendar} periods={scheduledPeriods(item)} selected={selected} onSelect={onSelect} label={item.name}>
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
        return <ChartRow key={fw.id} {...calendar} periods={dates} label={name}>
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
