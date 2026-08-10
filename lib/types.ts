export type PhaseType = "BUSINESS" | "DEVELOPMENT" | "QA" | "DEPLOY";

export type DevelopmentStatus =
  | "요청"
  | "검토중"
  | "일정수립"
  | "개발대기"
  | "개발중"
  | "품질검증"
  | "배포대기"
  | "완료"
  | "보류";

export interface Phase {
  id: string;
  type: PhaseType;
  start: string;
  end: string;
  md: number;
  progress: number;
}

export interface Issue {
  id: string;
  title: string;
  status: "등록" | "처리중" | "해결" | "보류";
  severity: "긴급" | "높음" | "보통" | "낮음";
  dueDate?: string;
}

export interface Development {
  id: string;
  code: string;
  name: string;
  customer: string;
  region: string;
  category: "프로젝트" | "유지보수" | "공통수정" | "내부개선";
  priority: "긴급" | "높음" | "보통" | "낮음";
  status: DevelopmentStatus;
  summary: string;
  requirements: string;
  assignees: string[];
  deploymentDate?: string;
  phases: Phase[];
  issues: Issue[];
  updatedAt: string;
}
