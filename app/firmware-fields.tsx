import { v4 as uuidv4 } from "uuid";
import { effortLabels, firmwareKinds, type Development, type DevelopmentStatus, type Effort, type Firmware } from "@/lib/types";
import { firmwareStages, type FirmwareStage } from "@/lib/schedule";
import { emptyFirmware, type PriorityEntry } from "@/lib/firmware";

export const statusOptions: DevelopmentStatus[] = ["대기중", "개발진행", "품질진행", "완료"];
const effortKeys = Object.keys(effortLabels) as (keyof Effort)[];
const headings = ["NO", "지역", "구분", "FW 버전", ...firmwareStages.map(stage => stage.label + "일정"), "진행사항"];

function DatePair({ fw, stage, number, onChange }: {
  fw: Firmware; stage: FirmwareStage; number: number; onChange: (patch: Partial<Firmware>) => void;
}) {
  const { start, end } = stage;
  const label = `FW ${number} ${stage.label}`;
  return <div className="fw-dates">
    <label><span>시작</span><input type="date" aria-label={label + " 시작일"} value={fw[start]} onInput={e => onChange({ [start]: e.currentTarget.value })} /></label>
    <label><span>종료</span><input type="date" aria-label={label + " 종료일"} min={fw[start] || undefined} value={fw[end]} onInput={e => onChange({ [end]: e.currentTarget.value })} /></label>
  </div>;
}

export function FirmwareEditor({ rows, onChange }: { rows: Firmware[]; onChange: (rows: Firmware[]) => void }) {
  const insert = (index: number) => onChange([...rows.slice(0, index), emptyFirmware(uuidv4()), ...rows.slice(index)]);
  return <fieldset><legend>개발 FW</legend>
    <div className="fw-table-wrap"><table className="fw-table fw-editor" aria-label="개발 FW 편집">
      <colgroup>
        <col className="fw-col-no" /><col className="fw-col-short" /><col className="fw-col-kind" /><col className="fw-col-short" />
        {firmwareStages.map(stage => <col key={stage.type} />)}
        <col className="fw-col-status" /><col className="fw-col-actions" />
      </colgroup>
      <thead><tr>{[...headings, "추가"].map(h => <th scope="col" key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((fw, index) => {
        const no = index + 1;
        const update = (patch: Partial<Firmware>) => onChange(rows.map(row => row.id === fw.id ? { ...row, ...patch } : row));
        return <tr key={fw.id}>
          <th scope="row">{no}</th>
          <td><input aria-label={`FW ${no} 지역`} value={fw.region} onChange={e => update({ region: e.target.value })} /></td>
          <td><select aria-label={`FW ${no} 구분`} value={fw.kind} onChange={e => update({ kind: e.target.value as Firmware["kind"] })}>
            <option value="">미지정</option>{firmwareKinds.map(k => <option key={k}>{k}</option>)}</select></td>
          <td><input aria-label={`FW ${no} 버전`} value={fw.version} onChange={e => update({ version: e.target.value })} /></td>
          {firmwareStages.map(stage => <td key={stage.type}><DatePair fw={fw} stage={stage} number={no} onChange={update} /></td>)}
          <td><select aria-label={`FW ${no} 진행사항`} value={fw.status} onChange={e => update({ status: e.target.value as DevelopmentStatus })}>{statusOptions.map(s => <option key={s}>{s}</option>)}</select></td>
          <td><div className="fw-row-actions">
            <button type="button" onClick={() => insert(no)} aria-label={`FW ${no} 아래 행 추가`}>＋</button>
            <button type="button" onClick={() => onChange(rows.filter(r => r.id !== fw.id))} aria-label={`FW ${no} 행 삭제`}>−</button>
          </div></td>
        </tr>;
      })}</tbody>
    </table></div>
    {!rows.length && <button type="button" className="fw-add-first" onClick={() => insert(0)}>＋ FW 추가</button>}
  </fieldset>;
}

export function EffortFields({ effort, onChange }: { effort: Effort; onChange?: (value: Effort) => void }) {
  return <div className="effort-fields">{effortKeys.map(key => <label key={key}>
    <span>{effortLabels[key]}</span>
    {onChange ? <input type="number" min="0" step="0.01" placeholder="0" defaultValue={effort[key] || ""} onChange={e => onChange({ ...effort, [key]: Number(e.target.value) })} /> : <strong>{effort[key]}</strong>}
    <small>MD</small>
  </label>)}</div>;
}

export function FirmwareDetails({ item, onStatus, busy }: {
  item: Development; onStatus: (id: string, status: DevelopmentStatus) => void; busy: boolean;
}) {
  const range = (start: string, end: string) => start ? `${start} ~ ${end}` : "미정";
  if (!item.firmware.length) return <p>등록된 FW가 없습니다.</p>;
  return <div className="fw-table-wrap"><table className="fw-table fw-details" aria-label="개발 FW 목록">
    <thead><tr>{headings.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
    <tbody>{item.firmware.map((fw, index) => <tr key={fw.id}>
      <th scope="row">{index + 1}</th><td>{fw.region || "미지정"}</td><td>{fw.kind || "미지정"}</td><td>{fw.version || "미지정"}</td>
      {firmwareStages.map(stage => <td key={stage.type}>{range(fw[stage.start], fw[stage.end])}</td>)}
      <td><select className={`row-status status-${fw.status}`} aria-label={`FW ${index + 1} 진행사항`}
        value={fw.status} disabled={busy} onChange={e => onStatus(fw.id, e.target.value as DevelopmentStatus)}>
        {statusOptions.map(status => <option key={status}>{status}</option>)}
      </select></td>
    </tr>)}</tbody>
  </table></div>;
}

export function PrioritySummary({ project, fw }: PriorityEntry) {
  return <div className="fw-priority-summary">
    <div><strong>{project.name}</strong><small>{[project.code, project.customer, fw.region || project.region].filter(Boolean).join(" · ")}</small></div>
    <div><strong>[{fw.kind || "구분 미지정"}] [{fw.version || "버전 미지정"}]</strong><small>담당자 {project.assignees.join(" · ") || "미지정"}</small></div>
    <div><span>배포 일정</span><small>{project.deploymentDate || "미정"}</small></div>
  </div>;
}
