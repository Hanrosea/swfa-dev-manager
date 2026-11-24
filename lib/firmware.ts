import type { Development, Effort, Firmware, Phase } from "./types";

export function emptyFirmware(id: string): Firmware {
  return { id, region: "", kind: "", version: "", devStart: "", devEnd: "", qaStart: "", qaEnd: "", status: "대기중" };
}

export function emptyEffort(): Effort {
  return { management: 0, design: 0, development: 0, quality: 0, execution: 0 };
}

export type LegacyDevelopment = Omit<Development, "firmware" | "effort"> & Partial<Pick<Development, "firmware" | "effort">>;

export function upgradeDevelopment(item: LegacyDevelopment): Development {
  if (item.firmware && item.effort) return { ...item, firmware: item.firmware, effort: item.effort };
  const phases = item.phases ?? [];
  const firmware = { ...emptyFirmware(item.id), region: item.region, status: item.status };
  const effort = emptyEffort();
  const effortKeys = { BUSINESS: "management", DEVELOPMENT: "development", QA: "quality", DEPLOY: "execution" } as const;
  for (const phase of phases) {
    effort[effortKeys[phase.type]] += phase.md;
    if (phase.type === "DEVELOPMENT" || phase.type === "QA") {
      const start = phase.type === "QA" ? "qaStart" : "devStart";
      const end = phase.type === "QA" ? "qaEnd" : "devEnd";
      if (!firmware[start] || phase.start < firmware[start]) firmware[start] = phase.start;
      if (phase.end > firmware[end]) firmware[end] = phase.end;
    }
  }
  return { ...item, phases, firmware: item.firmware ?? [firmware], effort: item.effort ?? effort };
}

export function scheduledPeriods(item: Development) {
  const periods: { id: string; type: Phase["type"]; start: string; end: string; label: string; lane: number }[] = [];
  for (const [index, fw] of item.firmware.entries()) {
    const label = [fw.region, fw.kind, fw.version || "버전 미지정"].filter(Boolean).join(" · ");
    if (fw.devStart && fw.devEnd) periods.push({ id: fw.id + "-dev", type: "DEVELOPMENT", start: fw.devStart, end: fw.devEnd, label, lane: index * 2 });
    if (fw.qaStart && fw.qaEnd) periods.push({ id: fw.id + "-qa", type: "QA", start: fw.qaStart, end: fw.qaEnd, label, lane: index * 2 + 1 });
  }
  const isReviewedBusiness = (phase: Phase) => phase.type === "BUSINESS" && phase.memo?.startsWith("검토본 사업기간 · ");
  const hasReviewedBusiness = item.phases.some(isReviewedBusiness);
  const byDates = new Map<string, typeof periods[number]>();
  for (const phase of item.phases) {
    if (phase.type !== "BUSINESS" && phase.type !== "DEPLOY") continue;
    if (phase.type === "BUSINESS" && hasReviewedBusiness && !isReviewedBusiness(phase)) continue;
    const label = phase.memo || "기존 일정";
    const key = [phase.type, phase.start, phase.end].join("/");
    const same = byDates.get(key);
    if (same) same.label += " / " + label;
    else byDates.set(key, { ...phase, label, lane: item.firmware.length * 2 + byDates.size });
  }
  periods.push(...byDates.values());
  return periods;
}

export type PriorityEntry = { project: Development; fw: Firmware };
export function qualityEntries(items: Development[]): PriorityEntry[] {
  return items.flatMap(project => project.firmware.filter(fw => fw.status === "품질진행").map(fw => ({ project, fw })));
}

export function projectProgress(item: Pick<Development, "id" | "status" | "phases" | "effort" | "firmware">) {
  const count = item.firmware.length;
  if (!count) return item.status === "완료" ? 100 : 0;
  if (item.firmware.every(fw => fw.status === "완료")) return 100;
  const totals = item.effort;
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  if (!total) return Math.min(99, Math.round(100 * item.firmware.filter(fw => fw.status === "완료").length / count));
  // Keep manually recorded phase progress as a floor for the migrated FW.
  const legacyProgress = (type: Phase["type"]) => {
    const phases = item.phases.filter(p => p.type === type);
    const md = phases.reduce((sum, p) => sum + p.md, 0);
    return md ? phases.reduce((sum, p) => sum + p.md * p.progress, 0) / md / 100 : 0;
  };
  const legacy = { business: legacyProgress("BUSINESS"), dev: legacyProgress("DEVELOPMENT"), qa: legacyProgress("QA"), deploy: legacyProgress("DEPLOY") };
  let done = 0;
  for (const fw of item.firmware) {
    if (fw.status === "완료") { done += total; continue; }
    const migrated = fw.id === item.id;
    const business = fw.status !== "대기중" ? 1 : migrated ? legacy.business : 0;
    const development = fw.status === "품질진행" ? 1 : migrated ? legacy.dev : 0;
    done += (totals.management + totals.design) * business + totals.development * development;
    if (migrated) done += totals.quality * legacy.qa + totals.execution * legacy.deploy;
  }
  return Math.min(99, Math.round(100 * done / (count * total)));
}
