import writeExcelFile, { type Row } from "write-excel-file/browser";
import type { DashboardEntry } from "./dashboard-schedule";
import { totalEffort } from "./firmware";
import { firmwareStages } from "./schedule";
import { effortLabels, type Effort } from "./types";

const effortKeys = Object.keys(effortLabels) as (keyof Effort)[];
type Column = [label: string, width: number];
const projects: Column[] = [
  ["개발코드", 20], ["개발명", 60], ["고객사", 18], ["지역", 22], ["구분", 14], ["담당자", 20],
  ["진행상태", 13], ["공정률", 10], ["사업기간", 40], ["FW 일정 시작일", 18], ["FW 일정 종료일", 18], ["배포예정일", 16],
  ...effortKeys.map((key): Column => [effortLabels[key] + " (MD)", 18]), ["합계 (MD)", 15], ["개발 상세", 70],
];
const firmware: Column[] = [
  ["개발코드", 20], ["개발명", 60], ["순번", 8], ["FW 지역", 22], ["FW 구분", 14], ["FW 버전", 18], ["진행사항", 14],
  ...firmwareStages.flatMap((stage): Column[] => [[stage.label + " 시작일", 16], [stage.label + " 종료일", 16]]),
];

function sheet(name: string, columns: Column[], rows: Row[]) {
  const header: Row = columns.map(([label]) => ({ value: label, fontWeight: "bold", textColor: "#FFFFFF", backgroundColor: "#304A6B" }));
  return { sheet: name, columns: columns.map(([, width]) => ({ width })), data: [header, ...rows], stickyRowsCount: 1 };
}

function excelDate(value?: string) {
  return value ? { type: Date, value: new Date(value + "T00:00:00Z"), format: "yyyy-mm-dd" } : null;
}

export async function exportSchedule(entries: DashboardEntry[], period: string) {
  const projectRows: Row[] = [];
  const firmwareRows: Row[] = [];
  for (const { item, progress, business, stages } of entries) {
    const work = stages.filter(stage => stage.type !== "deploy");
    const start = work.map(stage => stage.start).sort()[0];
    const end = work.map(stage => stage.end).sort().at(-1);
    projectRows.push([
      item.code, item.name, item.customer, item.region, item.category, item.assignees.join(" / "),
      progress === 100 ? "완료" : "진행중", { value: progress / 100, format: "0%" }, business.text,
      excelDate(start), excelDate(end), excelDate(item.deploymentDate),
      ...effortKeys.map(key => item.effort[key]), totalEffort(item.effort), item.summary,
    ]);
    item.firmware.forEach((fw, index) => firmwareRows.push([
      item.code, item.name, index + 1, fw.region, fw.kind, fw.version, fw.status,
      ...firmwareStages.flatMap(stage => [excelDate(fw[stage.start]), excelDate(fw[stage.end])]),
    ]));
  }
  await writeExcelFile([sheet("개발 내역", projects, projectRows), sheet("FW 일정", firmware, firmwareRows)])
    .toFile(`개발일정_${period}.xlsx`);
}
