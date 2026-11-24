export type IssueSeverity = "긴급" | "높음" | "보통" | "낮음";
export type IssueStatus = "등록" | "처리중" | "해결" | "보류";

export type Issue = {
  id: string;
  title: string;
  content: string;
  severity: IssueSeverity;
  status: IssueStatus;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
};

export const issueColumns = "id, title, content, severity, status, due_date, created_at, updated_at";

export function mapIssue(row: {
  id: string; title: string; content: string | null; severity: IssueSeverity; status: IssueStatus;
  due_date: string | null; created_at: string; updated_at: string;
}): Issue {
  return {
    id: row.id, title: row.title, content: row.content ?? "", severity: row.severity, status: row.status,
    dueDate: row.due_date ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function issueActivityKey(issueId: string) {
  return `mybi-infra-issue-activities-v1:${issueId}`;
}
