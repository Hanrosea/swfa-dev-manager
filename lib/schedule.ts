import type { Development, Firmware } from "./types";

export const firmwareStages = [
  { type: "design", label: "설계", start: "designStart", end: "designEnd" },
  { type: "development", label: "개발", start: "devStart", end: "devEnd" },
  { type: "qa", label: "품질", start: "qaStart", end: "qaEnd" },
] as const;
const deploymentStage = { type: "deploy", label: "배포" } as const;
export const timelineStages = [...firmwareStages, deploymentStage] as const;
export type FirmwareStage = (typeof firmwareStages)[number];
export type SchedulePeriod = Pick<(typeof timelineStages)[number], "type" | "label"> & { start: string; end: string };

export function deploymentAfterQuality(firmware: readonly Pick<Firmware, "qaEnd">[]): string | undefined {
  let last = "";
  for (const fw of firmware) {
    if (fw.qaEnd > last) last = fw.qaEnd;
  }
  if (!last) return undefined;
  const date = new Date(last + "T00:00:00Z");
  const weekday = date.getUTCDay();
  const daysUntilWeekday = weekday === 5 ? 3 : weekday === 6 ? 2 : 1;
  date.setUTCDate(date.getUTCDate() + daysUntilWeekday);
  return date.toISOString().slice(0, 10);
}

export function firmwarePeriods(fw: Firmware): SchedulePeriod[] {
  return firmwareStages.flatMap(stage => {
    const start = fw[stage.start];
    const end = fw[stage.end];
    return start && end ? [{ type: stage.type, label: stage.label, start, end }] : [];
  });
}

// Merge overlaps within each stage. Gaps between firmware schedules stay visible.
export function scheduledPeriods(project: Pick<Development, "firmware">): SchedulePeriod[] {
  const periods = project.firmware.flatMap(firmwarePeriods);
  periods.sort((a, b) => a.type.localeCompare(b.type) || a.start.localeCompare(b.start));
  const summary: SchedulePeriod[] = [];
  for (const period of periods) {
    const last = summary.at(-1);
    if (last && last.type === period.type && period.start <= last.end) {
      if (period.end > last.end) last.end = period.end;
    } else {
      summary.push(period);
    }
  }
  const deployment = deploymentAfterQuality(project.firmware);
  if (deployment) summary.push({ ...deploymentStage, start: deployment, end: deployment });
  return summary;
}
