import { useEffect, useRef, useState, type FormEvent } from "react";
import { v4 as uuidv4 } from "uuid";
import { issueActivityKey, type Issue } from "@/lib/issues";
import { getSupabaseBrowserClient } from "@/lib/supabase";

type Activity = { id: string; activity_date: string; content: string; created_at: string };
const activityColumns = "id, activity_date, content, created_at";

function localActivities(issueId: string): Activity[] {
  return JSON.parse(window.localStorage.getItem(issueActivityKey(issueId)) ?? "[]");
}

async function readActivities(issueId: string): Promise<Activity[]> {
  const db = getSupabaseBrowserClient();
  if (!db) return localActivities(issueId);
  const rows: Activity[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from("issue_activities").select(activityColumns)
      .eq("issue_id", issueId).order("created_at").order("id").range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

export function IssueDetail({ issue, editing, onEdit, onClose }: {
  issue: Issue; editing: boolean; onEdit: () => void; onClose: () => void;
}) {
  const [entries, setEntries] = useState<Activity[]>([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date()));
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const draftId = useRef("");
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    closeButton.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    let current = true;
    readActivities(issue.id).then(rows => {
      if (current) { setEntries(rows); setLoadError(false); }
    }).catch(() => { if (current) setLoadError(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [issue.id, reload]);

  async function addActivity(event: FormEvent) {
    event.preventDefault();
    if (saving || !date || !content.trim()) return;
    setSaving(true);
    setSaveError("");
    draftId.current ||= uuidv4();
    const row = { id: draftId.current, activity_date: date, content: content.trim() };
    try {
      const db = getSupabaseBrowserClient();
      if (db) {
        const { error } = await db.from("issue_activities").upsert({ ...row, issue_id: issue.id },
          { onConflict: "id", ignoreDuplicates: true });
        if (error) throw error;
      } else {
        const rows = localActivities(issue.id);
        if (!rows.some(entry => entry.id === row.id)) {
          rows.push({ ...row, created_at: new Date().toISOString() });
          window.localStorage.setItem(issueActivityKey(issue.id), JSON.stringify(rows));
        }
      }
      setContent("");
      draftId.current = "";
      setLoading(true);
      setReload(version => version + 1);
    } catch {
      setSaveError("활동기록을 저장하지 못했습니다. 연결 상태를 확인하고 다시 시도해주세요.");
    } finally {
      setSaving(false);
    }
  }

  return <aside className="detail-panel issue-detail" aria-label="이슈 상세" inert={editing}
    onKeyDown={event => { if (event.key === "Escape" && !saving) onClose(); }}>
    <header className="detail-head">
      <div><span className="detail-code">이슈사항</span><h2>{issue.title}</h2></div>
      <button ref={closeButton} type="button" onClick={onClose} aria-label="이슈 상세 닫기">×</button>
    </header>
    <div className="detail-scroll">
      <section className="detail-section">
        <h3>기본 정보</h3>
        <dl className="detail-grid issue-basics">
          <div><dt>처리상태</dt><dd><span className={`issue-status issue-status-${issue.status}`}>{issue.status}</span></dd></div>
          <div><dt>중요도</dt><dd className={`issue-severity-${issue.severity}`}>{issue.severity}</dd></div>
          <div><dt>완료 예정일</dt><dd>{issue.dueDate || "미정"}</dd></div>
        </dl>
      </section>
      <section className="detail-section"><h3>상세 내용</h3><p className="body-copy">{issue.content || "등록된 상세 내용이 없습니다."}</p></section>
      <section className="detail-section issue-history">
        <h3>활동기록</h3>
        <form className="activity-form" onSubmit={addActivity}>
          <label>날짜<input type="date" required value={date} disabled={saving} onChange={e => { draftId.current = ""; setDate(e.target.value); }} /></label>
          <label>활동기록<textarea rows={2} required value={content} disabled={saving}
            placeholder="주간 진행사항을 입력하세요" onChange={e => { draftId.current = ""; setContent(e.target.value); }} /></label>
          <button type="submit" className="primary-button" disabled={loading || loadError || saving || !date || !content.trim()}>
            {saving ? "저장 중..." : "기록 추가"}</button>
        </form>
        {saveError && <p role="alert" className="form-error">{saveError}</p>}
        {loading ? <p role="status">활동기록을 불러오는 중입니다.</p> : loadError ?
          <p role="alert">활동기록을 불러오지 못했습니다. <button type="button" onClick={() => { setLoading(true); setReload(v => v + 1); }}>다시 불러오기</button></p> :
          <table className="activity-table" aria-label="활동기록 목록">
            <thead><tr><th scope="col">NO</th><th scope="col">날짜</th><th scope="col">활동기록</th></tr></thead>
            <tbody>{entries.length ? entries.slice().reverse().map((entry, index) =>
              <tr key={entry.id}><td>{entries.length - index}</td><td><time dateTime={entry.activity_date}>{entry.activity_date}</time></td><td>{entry.content}</td></tr>
            ) : <tr><td colSpan={3} className="activity-empty">등록된 활동기록이 없습니다.</td></tr>}</tbody>
          </table>}
      </section>
    </div>
    <footer className="detail-actions"><button className="solid" type="button" onClick={onEdit}>수정</button></footer>
  </aside>;
}
