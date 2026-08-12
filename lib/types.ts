export type PhaseType = "BUSINESS" | "DEVELOPMENT" | "QA" | "DEPLOY";

export type DevelopmentStatus =
  | "대기중"
  | "개발진행"
  | "품질진행"
  | "완료";

export interface Phase {
  id: string;
  type: PhaseType;
  start: string;
  end: string;
  md: number;
  progress: number;
}

export interface Development {
  id: string;
  code: string;
  name: string;
  customer: string;
  region: string;
  category: "프로젝트" | "유지보수";
  status: DevelopmentStatus;
  summary: string;
  requirements: string;
  assignees: string[];
  deploymentDate?: string;
  phases: Phase[];
  updatedAt: string;
}

export type NotificationAction =
  | "DEVELOPMENT_CREATED"
  | "DEVELOPMENT_UPDATED"
  | "QA_PRIORITY_ADDED"
  | "QA_PRIORITY_REORDERED"
  | "QA_PRIORITY_REMOVED";

export interface AppNotification {
  id: string;
  action: NotificationAction;
  title: string;
  message: string;
  developmentId?: string;
  targetView: "dashboard" | "priority";
  createdAt: string;
}
