import { v4 as uuidv4 } from "uuid";
import { emptyRequirement } from "@/lib/firmware";
import { requirementStatuses, type Requirement, type RequirementStatus } from "@/lib/types";

type Props = { rows: Requirement[] } & (
  | { onChange: (rows: Requirement[]) => void; onStatus?: never; busy?: never }
  | { onChange?: never; onStatus: (id: string, status: RequirementStatus) => void; busy: boolean }
);

export function RequirementTable({ rows, onChange, onStatus, busy }: Props) {
  const fields = [["kind", "구분"], ["detail", "상세내용"], ["reason", "필요사유"]] as const;
  function patch(id: string, change: Partial<Requirement>) {
    onChange?.(rows.map(row => row.id === id ? { ...row, ...change } : row));
  }
  return <>
    <div className="fw-table-wrap">
      <table className="fw-table requirement-table" aria-label="필요사항 목록">
        <thead><tr>{["NO", "구분", "상세내용", "필요사유", "진행일정", "진행사항"].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => {
          const label = `필요사항 ${index + 1}`;
          return <tr key={row.id}>
            <th scope="row">{index + 1}
              {onChange && <button type="button" className="requirement-remove" aria-label={label + "행 삭제"}
                onClick={() => onChange(rows.filter(other => other.id !== row.id))}>×</button>}
            </th>
            {fields.map(([key, title]) => <td key={key}>{onChange
              ? (key === "kind" ? <input aria-label={label + " " + title} value={row[key]} onChange={e => patch(row.id, { [key]: e.target.value })} />
                : <textarea rows={2} aria-label={label + " " + title} value={row[key]} onChange={e => patch(row.id, { [key]: e.target.value })} />)
              : row[key] || "—"}</td>)}
            <td>{onChange ? <input type="date" aria-label={label + " 진행일정"} value={row.scheduledOn}
              onInput={e => patch(row.id, { scheduledOn: e.currentTarget.value })} /> : row.scheduledOn || "미정"}</td>
            <td><select className="row-status" aria-label={label + " 진행사항"} value={row.status ?? ""} disabled={busy}
              onChange={e => {
                const status = e.target.value as RequirementStatus;
                if (onChange) patch(row.id, { status });
                else onStatus(row.id, status);
              }}>
              {!row.status && <option value="" disabled>선택</option>}
              {requirementStatuses.map(status => <option key={status}>{status}</option>)}
            </select></td>
          </tr>;
        })}{!rows.length && <tr><td colSpan={6} className="requirements-empty">등록된 필요사항이 없습니다.</td></tr>}</tbody>
      </table>
    </div>
    {onChange && <button type="button" className="fw-add-first" onClick={() => onChange([...rows, emptyRequirement(uuidv4())])}>＋ 필요사항 추가</button>}
  </>;
}
