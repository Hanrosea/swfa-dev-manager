import type { Development, Effort, Firmware, Phase, ProjectRowChange, Requirement } from "./types";
import { deploymentAfterQuality } from "./schedule";

export function emptyFirmware(id: string): Firmware {
  return { id, region: "", kind: "", version: "", designStart: "", designEnd: "", devStart: "", devEnd: "", qaStart: "", qaEnd: "", status: "대기중" };
}

export function emptyEffort(): Effort {
  return { management: 0, design: 0, development: 0, quality: 0, execution: 0 };
}

export function emptyRequirement(id: string): Requirement {
  return { id, kind: "", detail: "", reason: "", scheduledOn: "", status: "자료요청" };
}

export function legacyRequirements(projectId: string, note: string): Requirement[] {
  return note.trim() ? [{ ...emptyRequirement(projectId), detail: note, status: null }] : [];
}

export function withRowStatus(project: Development, change: ProjectRowChange): Development {
  if (change.type === "requirement") {
    return { ...project, requirements: project.requirements.map(row => row.id === change.id ? { ...row, status: change.status } : row) };
  }
  return { ...project, firmware: project.firmware.map(fw => fw.id === change.id ? { ...fw, status: change.status } : fw) };
}

type StoredFirmware = Omit<Firmware, "designStart" | "designEnd"> & Partial<Pick<Firmware, "designStart" | "designEnd">>;
export type LegacyDevelopment = Omit<Development, "firmware" | "effort" | "requirements">
  & Partial<Pick<Development, "effort">> & { firmware?: StoredFirmware[]; requirements?: string | Requirement[] | null };

export function upgradeDevelopment(item: LegacyDevelopment): Development {
  const requirements = Array.isArray(item.requirements) ? item.requirements : legacyRequirements(item.id, item.requirements ?? "");
  const storedRows = item.firmware?.map(fw => ({ ...fw, designStart: fw.designStart ?? "", designEnd: fw.designEnd ?? "" }));
  if (storedRows && item.effort) {
    return { ...item, requirements, firmware: storedRows, deploymentDate: deploymentAfterQuality(storedRows), effort: item.effort };
  }
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
  const rows = storedRows ?? [firmware];
  return { ...item, phases, requirements, firmware: rows, deploymentDate: deploymentAfterQuality(rows), effort: item.effort ?? effort };
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
