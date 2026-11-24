export type PhaseType = "BUSINESS" | "DEVELOPMENT" | "QA" | "DEPLOY";

export type DevelopmentStatus =
  | "대기중"
  | "개발진행"
  | "품질진행"
  | "완료";

export interface Phase {
  id: string;
  type: PhaseType;
  memo?: string;
  start: string;
  end: string;
  md: number;
  progress: number;
}

export const firmwareKinds = ["운전자", "승하차", "운영정보"] as const;
export interface Firmware {
  id: string;
  region: string;
  kind: (typeof firmwareKinds)[number] | "";
  version: string;
  devStart: string;
  devEnd: string;
  qaStart: string;
  qaEnd: string;
  status: DevelopmentStatus;
}

export const effortLabels = {
  management: "사업 총괄",
  design: "분석 및 설계",
  development: "개발",
  quality: "품질 테스트",
  execution: "사업 수행",
} as const;
export type Effort = Record<keyof typeof effortLabels, number>;

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
  phases: Phase[]; // Original phase records retained for historical reference.
  firmware: Firmware[];
  effort: Effort;
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
