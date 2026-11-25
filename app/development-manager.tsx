"use client";

import { v4 as uuidv4 } from "uuid";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { EffortFields, FirmwareDetails, FirmwareEditor, PrioritySummary } from "./firmware-fields";
import { projectProgress, totalEffort, emptyEffort, emptyFirmware, emptyRequirement, legacyRequirements, withRowStatus, qualityEntries, upgradeDevelopment, type LegacyDevelopment, type PriorityEntry } from "@/lib/firmware";
import { dashboardCalendar, dashboardEntry, localDate, overlaps, type DashboardView } from "@/lib/dashboard-schedule";
import { deploymentAfterQuality, firmwareStages, scheduledPeriods } from "@/lib/schedule";
import { TimelineRow } from "./schedule-timeline";
import { RequirementTable } from "./requirement-table";
import { IssueDetail } from "./issue-detail";
import { PasswordDialog } from "./password-dialog";
import { issueActivityKey, issueColumns, mapIssue, type Issue, type IssueSeverity, type IssueStatus } from "@/lib/issues";
import { initialDevelopments } from "@/lib/mock-data";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  AppNotification,
  Development,
  DevelopmentStatus,
  NotificationAction,
  ProjectRowChange,
  Requirement,
  Effort,
  Firmware,
  PhaseType,
} from "@/lib/types";

const STORAGE_KEY = "mybi-infra-dev-manager-v1";
const PRIORITY_STORAGE_KEY = "mybi-infra-qa-priority-v1";
const ISSUE_STORAGE_KEY = "mybi-infra-issues-v1";
const NOTIFICATION_STORAGE_KEY = "mybi-infra-notifications-v1";
const READ_NOTIFICATION_STORAGE_KEY = "mybi-infra-read-notifications-v1";
const notificationActions: NotificationAction[] = [
  "DEVELOPMENT_CREATED",
  "DEVELOPMENT_UPDATED",
  "QA_PRIORITY_ADDED",
  "QA_PRIORITY_REORDERED",
  "QA_PRIORITY_REMOVED",
];
const projectSelect = "*, development_phases(*), development_firmware(*), development_requirements(*)";
const progressStates = ["진행중", "완료"] as const;
type ProgressState = (typeof progressStates)[number];

function normalizeStatus(value: unknown): DevelopmentStatus {
  if (value === "완료" || value === "대기중" || value === "개발진행" || value === "품질진행") {
    return value;
  }

  if (["진행중", "개발중"].includes(String(value))) {
    return "개발진행";
  }

  if (["품질검증", "배포대기"].includes(String(value))) {
    return "품질진행";
  }

  return "대기중";
}

const menuItems = [
  { id: "dashboard", label: "일정 대시보드", icon: "▦" },
  { id: "priority", label: "우선 순위", icon: "↕" },
  { id: "issues", label: "이슈사항", icon: "!" },
] as const;

function formatShortDate(value?: string) {
  if (!value) return "-";
  const [, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function dateRange(item: Development) {
  const { start, end } = scheduleBounds(item);
  return start ? `${formatShortDate(start)} ~ ${formatShortDate(end)}` : "미정";
}

function scheduleBounds(item: Development) {
  const dates = scheduledPeriods(item).flatMap(period => [period.start, period.end]).sort();
  return { start: dates[0] ?? "", end: dates.at(-1) ?? "" };
}

function findScheduleConflicts(candidate: Development, items: Development[]) {
  const periods = scheduledPeriods(candidate);
  return items.filter(item => item.id !== candidate.id && scheduledPeriods(item).some(other =>
    periods.some(period => period.start <= other.end && other.start <= period.end)));
}

function describeDevelopmentChange(before: Development, after: Development) {
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`개발명: ${before.name} → ${after.name}`);
  if (before.status !== after.status) changes.push(`상태: ${before.status} → ${after.status}`);
  if (
    before.customer !== after.customer ||
    before.region !== after.region ||
    before.category !== after.category
  ) {
    changes.push("기본 정보 수정");
  }
  if (JSON.stringify(before.firmware) !== JSON.stringify(after.firmware)) changes.push("개발 FW 수정");
  if (JSON.stringify(before.effort) !== JSON.stringify(after.effort)) changes.push("공수 수정");
  if (before.deploymentDate !== after.deploymentDate) changes.push("배포 예정일 수정");
  if (before.assignees.join("|") !== after.assignees.join("|")) {
    changes.push(`담당자: ${after.assignees.join(", ") || "미지정"}`);
  }
  if (JSON.stringify(before.requirements) !== JSON.stringify(after.requirements)) changes.push("필요사항 수정");
  if (before.summary !== after.summary) {
    changes.push("개발 내용 수정");
  }
  return changes.slice(0, 2).join(" · ") || "개발업무 내용이 수정되었습니다.";
}

function notificationTarget(action: NotificationAction): AppNotification["targetView"] {
  return action === "DEVELOPMENT_CREATED" || action === "DEVELOPMENT_UPDATED"
    ? "dashboard"
    : "priority";
}

function mapActivityNotification(row: Record<string, unknown>): AppNotification | null {
  const action = String(row.action) as NotificationAction;
  if (!notificationActions.includes(action)) return null;
  const changedData = (row.changed_data as Record<string, unknown> | null) ?? {};
  return {
    id: String(row.id),
    action,
    title: String(changedData.title ?? "개발업무 알림"),
    message: String(changedData.message ?? "개발업무에 변경사항이 있습니다."),
    developmentId: row.development_id ? String(row.development_id) : undefined,
    targetView: notificationTarget(action),
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

function formatNotificationTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function createCode(items: Development[]) {
  const year = new Date().getFullYear();
  const max = items.reduce((value, item) => {
    const number = Number(item.code.split("-").at(-1));
    return Number.isNaN(number) ? value : Math.max(value, number);
  }, 0);
  return `DEV-${year}-${String(max + 1).padStart(4, "0")}`;
}

function mapDatabaseRow(row: Record<string, unknown>): Development {
  const phases = (row.development_phases as Record<string, unknown>[] | null) ?? [];
  const rows = (row.development_firmware ?? []) as Record<string, unknown>[];
  const requirements = (row.development_requirements ?? []) as Record<string, unknown>[];
  return {
    id: String(row.id),
    code: String(row.development_code),
    name: String(row.name),
    customer: String(row.customer ?? ""),
    region: String(row.region ?? ""),
    category: row.category as Development["category"],
    status: normalizeStatus(row.status),
    summary: String(row.summary ?? ""),
    requirements: requirements.length
      ? requirements.slice().sort((a, b) => Number(a.row_no) - Number(b.row_no)).map(r => ({
        id: String(r.id), kind: String(r.kind), detail: String(r.detail), reason: String(r.reason),
        scheduledOn: String(r.scheduled_on ?? ""), status: r.status as Requirement["status"],
      }))
      : legacyRequirements(String(row.id), String(row.requirements ?? "")),
    assignees: (row.assignee_names as string[] | null) ?? [],
    deploymentDate: row.deployment_date ? String(row.deployment_date) : undefined,
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
    effort: { ...emptyEffort(), ...(row.effort_md as Partial<Effort>) },
    firmware: rows.slice().sort((a, b) => Number(a.row_no) - Number(b.row_no)).map(fw => ({
      id: String(fw.id), region: String(fw.region), kind: fw.kind as Firmware["kind"], version: String(fw.version),
      designStart: String(fw.design_start ?? ""), designEnd: String(fw.design_end ?? ""),
      devStart: String(fw.dev_start ?? ""), devEnd: String(fw.dev_end ?? ""),
      qaStart: String(fw.qa_start ?? ""), qaEnd: String(fw.qa_end ?? ""), status: normalizeStatus(fw.status),
    })),
    phases: phases.map((phase) => ({
      id: String(phase.id),
      type: phase.phase_type as PhaseType,
      memo: String(phase.memo ?? ""),
      start: String(phase.planned_start),
      end: String(phase.planned_end),
      md: Number(phase.planned_md ?? 0),
      progress: Number(phase.progress ?? 0),
    })),
  };
}

function databasePriorityIds(rows: Record<string, unknown>[]) {
  return rows.flatMap(row => (row.development_firmware ?? []) as { id: string; qa_order: number | null }[])
    .filter((fw): fw is { id: string; qa_order: number } => fw.qa_order !== null)
    .sort((a, b) => a.qa_order - b.qa_order)
    .map(fw => fw.id);
}

export default function DevelopmentManager() {
  const [items, setItems] = useState<Development[]>(isSupabaseConfigured ? [] : initialDevelopments);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [month, setMonth] = useState(() => {
    const current = new Date();
    return new Date(current.getFullYear(), current.getMonth(), 1);
  });
  const [scheduleView, setScheduleView] = useState<DashboardView>("month");
  const [includeUndated, setIncludeUndated] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [query, setQuery] = useState("");
  const [categoryFilters, setCategoryFilters] = useState<Development["category"][]>([]);
  const [assigneeFilters, setAssigneeFilters] = useState<string[]>([]);
  const [progressFilters, setProgressFilters] = useState<ProgressState[]>(["진행중"]);
  const [showForm, setShowForm] = useState(false);
  const [editingDevelopment, setEditingDevelopment] = useState<Development | null>(null);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [loadError, setLoadError] = useState("");
  const [localReady, setLocalReady] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [passwordAccountId, setPasswordAccountId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"dashboard" | "priority" | "issues">("dashboard");
  const [priorityIds, setPriorityIds] = useState<string[]>([]);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [draggingPriorityId, setDraggingPriorityId] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const selectedIssue = issues.find(issue => issue.id === selectedIssueId);
  const [issueListError, setIssueListError] = useState("");
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);

  const refreshNotifications = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      try {
        const saved = window.localStorage.getItem(NOTIFICATION_STORAGE_KEY);
        const parsed = saved ? (JSON.parse(saved) as AppNotification[]) : [];
        setNotifications(Array.isArray(parsed) ? parsed.slice(0, 30) : []);
      } catch {
        window.localStorage.removeItem(NOTIFICATION_STORAGE_KEY);
      }
      return;
    }

    const { data, error } = await supabase
      .from("activity_logs")
      .select("id, development_id, action, changed_data, created_at")
      .in("action", notificationActions)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      console.warn("알림을 불러오지 못했습니다.", error.message);
      return;
    }
    setNotifications(
      (data ?? [])
        .map((row) => mapActivityNotification(row as Record<string, unknown>))
        .filter((item): item is AppNotification => Boolean(item)),
    );
  }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      const savedPriorities = window.localStorage.getItem(PRIORITY_STORAGE_KEY);
      const savedIssues = window.localStorage.getItem(ISSUE_STORAGE_KEY);
      let loadedItems = initialDevelopments;
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as LegacyDevelopment[];
          if (Array.isArray(parsed)) {
            loadedItems = parsed.map(item => upgradeDevelopment({ ...item, status: normalizeStatus(item.status) }));
            queueMicrotask(() => setItems(loadedItems));
          }
        } catch {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      }
      if (savedPriorities) {
        try {
          const parsed = JSON.parse(savedPriorities) as string[];
          if (Array.isArray(parsed)) {
            const qualityIds = new Set(
              qualityEntries(loadedItems).map(entry => entry.fw.id),
            );
            queueMicrotask(() => setPriorityIds(parsed.filter((id) => qualityIds.has(id))));
          }
        } catch {
          window.localStorage.removeItem(PRIORITY_STORAGE_KEY);
        }
      }
      if (savedIssues) {
        try {
          const parsed = JSON.parse(savedIssues) as Issue[];
          if (Array.isArray(parsed)) queueMicrotask(() => setIssues(parsed));
        } catch {
          window.localStorage.removeItem(ISSUE_STORAGE_KEY);
        }
      }
      queueMicrotask(() => setLocalReady(true));
      return;
    }

    let mounted = true;
    const load = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!mounted) return;
      setUserEmail(sessionData.session?.user.email ?? null);
      setUserId(sessionData.session?.user.id ?? null);
      if (sessionData.session) {
        const [developmentResult, issueResult] = await Promise.all([
          supabase
            .from("developments")
            .select(projectSelect)
            .is("deleted_at", null)
            .order("updated_at", { ascending: false }),
          supabase
            .from("issues")
            .select(issueColumns)
            .order("updated_at", { ascending: false }),
        ]);
        if (!mounted) return;
        if (developmentResult.error) {
          setLoadError("프로젝트 데이터를 불러올 수 없습니다. DB 연결과 프로젝트 마이그레이션 적용 여부를 확인해주세요.");
        }
        if (!developmentResult.error) {
          const loadedItems = (developmentResult.data ?? []).map(mapDatabaseRow);
          setItems(loadedItems);
          setPriorityIds(databasePriorityIds(developmentResult.data ?? []));
        }
        if (issueResult.error) setIssueListError("이슈 목록을 불러오지 못했습니다. 새로고침 후 다시 확인해주세요.");
        else setIssues(issueResult.data.map(mapIssue));
      }
      setLoading(false);
    };
    load();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user.email ?? null);
      setUserId(session?.user.id ?? null);
      setPasswordAccountId(id => id === session?.user.id ? id : null);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured && localReady) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    }
  }, [items, localReady]);

  useEffect(() => {
    if (!isSupabaseConfigured && localReady) {
      window.localStorage.setItem(PRIORITY_STORAGE_KEY, JSON.stringify(priorityIds));
    }
  }, [priorityIds, localReady]);

  useEffect(() => {
    if (!isSupabaseConfigured && localReady) {
      window.localStorage.setItem(ISSUE_STORAGE_KEY, JSON.stringify(issues));
    }
  }, [issues, localReady]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(READ_NOTIFICATION_STORAGE_KEY);
      const parsed = saved ? (JSON.parse(saved) as string[]) : [];
      if (Array.isArray(parsed)) queueMicrotask(() => setReadNotificationIds(parsed));
    } catch {
      window.localStorage.removeItem(READ_NOTIFICATION_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (isSupabaseConfigured && !userId) return;
    queueMicrotask(() => void refreshNotifications());
    if (!isSupabaseConfigured) return;
    const timer = window.setInterval(() => void refreshNotifications(), 15000);
    return () => window.clearInterval(timer);
  }, [userId, refreshNotifications]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const assignees = useMemo(
    () => Array.from(new Set(items.flatMap((item) => item.assignees))).sort(),
    [items],
  );

  const today = localDate(new Date());
  const calendar = useMemo(() => dashboardCalendar(month, scheduleView, today), [month, scheduleView, today]);
  const schedules = useMemo(() => items.map(dashboardEntry), [items]);
  const selectedYear = month.getFullYear();
  const currentYear = Number(today.slice(0, 4));
  const years = useMemo(() => {
    const values = new Set([selectedYear, currentYear]);
    for (const { dateRanges } of schedules) {
      for (const period of dateRanges) {
        values.add(Number(period.start.slice(0, 4)));
        if (period.end) values.add(Number(period.end.slice(0, 4)));
      }
    }
    const first = Math.max(1000, Math.min(currentYear - 5, ...values) - 1);
    const last = Math.min(9999, Math.max(currentYear + 5, ...values) + 1);
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }, [schedules, selectedYear, currentYear]);
  const periodRows = useMemo(() => schedules.filter(entry =>
    (includeUndated && entry.undated) || entry.dateRanges.some(period => overlaps(period, calendar))
  ), [schedules, calendar, includeUndated]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return periodRows.filter(({ item, progress }) => {
      const matchesQuery =
        !normalized ||
        [item.name, item.code, item.customer, item.region, ...item.assignees, ...item.firmware.flatMap(fw => [fw.region, fw.kind, fw.version])]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return (
        matchesQuery &&
        (!categoryFilters.length || categoryFilters.includes(item.category)) &&
        (!assigneeFilters.length || item.assignees.some((name) => assigneeFilters.includes(name))) &&
        (!progressFilters.length || progressFilters.includes(progress === 100 ? "완료" : "진행중"))
      );
    });
  }, [periodRows, query, categoryFilters, assigneeFilters, progressFilters]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const undatedCount = schedules.filter(entry => entry.undated).length;
  const completedCount = periodRows.filter(entry => entry.progress === 100).length;
  const activeCount = periodRows.length - completedCount;
  const delayedCount = periodRows.filter(({item, progress}) => {
    const end = scheduleBounds(item).end;
    return end && end < today && progress < 100;
  }).length;

  const annual = scheduleView === "year";
  const changePeriod = (offset: number) => {
    setMonth(current => new Date(current.getFullYear(), current.getMonth() + (annual ? 12 : 1) * offset, 1));
  };

  const showMessage = (message: string) => setToast(message);

  const downloadSchedule = async () => {
    setExporting(true);
    try {
      const { exportSchedule } = await import("@/lib/export-schedule");
      await exportSchedule(filtered, calendar.start.slice(0, annual ? 4 : 7));
    } catch {
      showMessage("엑셀 파일을 만들지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setExporting(false);
    }
  };

  const storeReadNotificationIds = (ids: string[]) => {
    const nextIds = Array.from(new Set(ids)).slice(0, 200);
    setReadNotificationIds(nextIds);
    window.localStorage.setItem(READ_NOTIFICATION_STORAGE_KEY, JSON.stringify(nextIds));
  };

  const markNotificationRead = (notificationId: string) => {
    storeReadNotificationIds([notificationId, ...readNotificationIds]);
  };

  const createActivityNotification = async ({
    action,
    title,
    message,
    developmentId,
  }: {
    action: NotificationAction;
    title: string;
    message: string;
    developmentId?: string;
  }) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      const notification: AppNotification = {
        id: uuidv4(),
        action,
        title,
        message,
        developmentId,
        targetView: notificationTarget(action),
        createdAt: new Date().toISOString(),
      };
      let current = notifications;
      try {
        const saved = window.localStorage.getItem(NOTIFICATION_STORAGE_KEY);
        const parsed = saved ? (JSON.parse(saved) as AppNotification[]) : [];
        if (Array.isArray(parsed)) current = parsed;
      } catch {
        window.localStorage.removeItem(NOTIFICATION_STORAGE_KEY);
      }
      const next = [notification, ...current].slice(0, 30);
      setNotifications(next);
      window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(next));
      return true;
    }

    const actorId = userId ?? (await supabase.auth.getSession()).data.session?.user.id;
    if (!actorId) return false;
    const { data, error } = await supabase
      .from("activity_logs")
      .insert({
        development_id: developmentId ?? null,
        actor_id: actorId,
        action,
        changed_data: { title, message, target_view: notificationTarget(action) },
      })
      .select("id, development_id, action, changed_data, created_at")
      .single();
    if (error) {
      console.warn("알림을 등록하지 못했습니다.", error.message);
      return false;
    }
    const notification = mapActivityNotification(data as Record<string, unknown>);
    if (notification) {
      setNotifications((current) => [
        notification,
        ...current.filter((item) => item.id !== notification.id),
      ].slice(0, 30));
    }
    return true;
  };

  const openNotification = async (notification: AppNotification) => {
    markNotificationRead(notification.id);
    setShowNotifications(false);
    setActiveView(notification.targetView);
    if (!notification.developmentId) {
      setSelectedId(null);
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      const { data, error } = await supabase.from("developments").select(projectSelect)
        .is("deleted_at", null).order("updated_at", { ascending: false });
      if (error) {
        showMessage(`개발 정보를 불러오지 못했습니다: ${error.message}`);
        return;
      }
      const latest = data.map(mapDatabaseRow);
      setItems(latest);
      setPriorityIds(databasePriorityIds(data));
      const target = latest.find(item => item.id === notification.developmentId);
      if (!target) {
        setSelectedId(null);
        showMessage("삭제된 개발 건입니다.");
        return;
      }
      const range = scheduleBounds(target);
      if (range.start) {
        const start = new Date(`${range.start}T00:00:00`);
        setMonth(new Date(start.getFullYear(), start.getMonth(), 1));
      }
    }
    setSelectedId(notification.developmentId);
  };

  const handleLogout = async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      showMessage("데모 모드에서는 로그아웃이 필요하지 않습니다.");
      return;
    }
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) {
      showMessage(`로그아웃 실패: ${error.message}`);
      return;
    }
    setSelectedIssueId(null);
    setUserEmail(null);
    setUserId(null);
    setSelectedId(null);
  };

  const storeProject = (development: Development, previous?: Development) => {
    const removedIds = new Set(previous?.firmware.map(fw => fw.id));
    for (const fw of development.firmware) {
      if (fw.status === "품질진행") removedIds.delete(fw.id);
    }
    setPriorityIds(current => current.filter(id => !removedIds.has(id)));
    setItems(current => previous
      ? current.map(item => item.id === development.id ? development : item)
      : [development, ...current.filter(item => item.id !== development.id)]);
  };

  const saveDevelopment = async (development: Development) => {
    const previous = items.find((item) => item.id === development.id);
    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      const { data, error } = await supabase.rpc("save_development_fw", {
        project: development,
        expected_updated_at: previous ? development.updatedAt : null,
      });
      if (error) {
        showMessage(`저장 실패: ${error.message}`);
        return false;
      }
      development = { ...development, updatedAt: String(data) };
    } else {
      development = { ...development, updatedAt: new Date().toISOString() };
    }
    storeProject(development, previous);
    setSelectedId(development.id);
    await createActivityNotification({
      action: previous ? "DEVELOPMENT_UPDATED" : "DEVELOPMENT_CREATED",
      title: previous ? "개발업무 수정" : "개발업무 업로드",
      message: previous
        ? `“${development.name}” ${describeDevelopmentChange(previous, development)}`
        : `“${development.name}” 개발업무가 등록되었습니다.`,
      developmentId: development.id,
    });
    showMessage("변경사항을 저장했습니다.");
    return true;
  };

  const saveRowStatus = async (item: Development, change: ProjectRowChange) => {
    const rows = change.type === "requirement" ? item.requirements : item.firmware;
    const index = rows.findIndex(row => row.id === change.id);
    const row = rows[index];
    if (!row || row.status === change.status) return;
    const db = getSupabaseBrowserClient();
    let saved: Development;
    if (db) {
      const { data, error } = await db.rpc("set_development_row_status", {
        target_project: item.id, row_type: change.type, target_row: change.id,
        expected_status: row.status, next_status: change.status,
      });
      if (error) {
        if (error.code === "40001") {
          const latest = await db.from("developments").select(projectSelect).eq("id", item.id).is("deleted_at", null).maybeSingle();
          if (!latest.error && latest.data) {
            storeProject(mapDatabaseRow(latest.data), item);
            showMessage("다른 사용자의 변경사항을 불러왔습니다. 진행사항을 다시 선택해주세요.");
            return;
          }
          if (!latest.error && !latest.data) {
            setItems(current => current.filter(project => project.id !== item.id));
            setSelectedId(current => current === item.id ? null : current);
          }
        }
        showMessage(`진행사항 저장 실패: ${error.message}`);
        return;
      }
      saved = mapDatabaseRow(data);
    } else {
      saved = { ...withRowStatus(item, change), updatedAt: new Date().toISOString() };
    }
    storeProject(saved, item);
    const section = change.type === "requirement" ? "필요사항" : "개발 FW";
    showMessage(`${section} 진행사항을 저장했습니다.`);
    await createActivityNotification({
      action: "DEVELOPMENT_UPDATED", title: `${section} 진행사항 변경`, developmentId: item.id,
      message: `“${item.name}” ${section} ${index + 1}행 · ${row.status ?? "미지정"} → ${change.status}`,
    });
  };

  const savePriorityOrder = async (ids: string[], successMessage?: string) => {
    const qualityIds = new Set(qualityEntries(items).map(entry => entry.fw.id));
    const nextIds = [...new Set(ids)].filter(id => qualityIds.has(id));
    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      const { error } = await supabase.rpc("save_fw_priorities", { expected_ids: priorityIds, ordered_ids: nextIds });
      if (error) {
        showMessage(`우선순위 저장 실패: ${error.message}`);
        return false;
      }
    }
    setPriorityIds(nextIds);
    if (successMessage) showMessage(successMessage);
    return true;
  };

  const saveIssue = async (issue: Issue) => {
    const previous = selectedIssue;
    const supabase = getSupabaseBrowserClient();
    let saved = issue;
    if (supabase) {
      const fields = {
        title: issue.title,
        content: issue.content || null,
        severity: issue.severity,
        status: issue.status,
        due_date: issue.dueDate || null,
        ...(previous?.status !== issue.status && {
          resolved_at: issue.status === "해결" ? new Date().toISOString() : null,
        }),
      };
      const request = previous
        ? supabase.from("issues").update(fields).eq("id", issue.id).eq("updated_at", previous.updatedAt)
        : supabase.from("issues").insert({ id: issue.id, ...fields });
      const { data, error } = await request.select(issueColumns).maybeSingle();
      if (error || !data) {
        showMessage(error ? `이슈사항 저장 실패: ${error.message}` : "이슈가 변경되었거나 삭제되었습니다. 새로고침 후 다시 확인해주세요.");
        return false;
      }
      saved = mapIssue(data);
    }
    setIssues(current => [saved, ...current.filter(item => item.id !== saved.id)]);
    setSelectedIssueId(saved.id);
    setShowIssueForm(false);
    showMessage(previous ? "이슈사항을 수정했습니다." : "이슈사항을 등록했습니다.");
    return true;
  };

  const removeIssue = async (id: string) => {
    if (!window.confirm("이 이슈사항과 활동기록을 함께 삭제할까요?")) return;
    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      const { error } = await supabase.from("issues").delete().eq("id", id);
      if (error) {
        showMessage(`이슈사항 삭제 실패: ${error.message}`);
        return;
      }
    }
    if (!supabase) window.localStorage.removeItem(issueActivityKey(id));
    setIssues((current) => current.filter((issue) => issue.id !== id));
    showMessage("이슈사항을 삭제했습니다.");
  };

  const deleteDevelopment = async (development: Development) => {
    if (!window.confirm(`'${development.name}' 개발 건을 삭제할까요?`)) return;

    const supabase = getSupabaseBrowserClient();
    if (supabase) {
      const { error } = await supabase
        .from("developments")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", development.id);
      if (error) {
        showMessage(`삭제 실패: ${error.message}`);
        return;
      }
    }

    setItems((current) => current.filter((item) => item.id !== development.id));
    const removed = new Set(development.firmware.map(fw => fw.id));
    setPriorityIds(current => current.filter(id => !removed.has(id)));
    setSelectedId(null);
    showMessage("개발 건을 삭제했습니다.");
  };

  const eligible = qualityEntries(items);
  const byFirmwareId = new Map(eligible.map(entry => [entry.fw.id, entry]));
  const priorityItems = priorityIds.flatMap(id => byFirmwareId.get(id) ?? []);
  const priorityCandidates = eligible.filter(entry => !priorityIds.includes(entry.fw.id));
  const priorityName = (id: string) => {
    const entry = byFirmwareId.get(id);
    return entry ? `${entry.project.name} [${entry.fw.kind || "미지정"}] [${entry.fw.version || "버전 미지정"}]` : "개발 FW";
  };

  const addPriorityItems = async (ids: string[]) => {
    const saved = await savePriorityOrder(
      [...priorityIds, ...ids],
      ids.length ? `${ids.length}건을 우선순위에 추가했습니다.` : undefined,
    );
    if (saved) {
      for (const id of ids) {
        const entry = byFirmwareId.get(id);
        if (!entry) continue;
        await createActivityNotification({
          action: "QA_PRIORITY_ADDED",
          title: "품질진행 업로드",
          message: `“${priorityName(id)}” 품질 테스트가 등록되었습니다.`,
          developmentId: entry.project.id,
        });
      }
      setShowPriorityPicker(false);
    }
  };

  const movePriority = async (firmwareId: string, offset: number) => {
    const currentIndex = priorityIds.indexOf(firmwareId);
    const nextIndex = currentIndex + offset;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= priorityIds.length) return;
    const nextIds = [...priorityIds];
    const displacedId = nextIds[nextIndex];
    [nextIds[currentIndex], nextIds[nextIndex]] = [nextIds[nextIndex], nextIds[currentIndex]];
    const saved = await savePriorityOrder(nextIds, "우선순위 순서를 저장했습니다.");
    if (saved) {
      await createActivityNotification({
        action: "QA_PRIORITY_REORDERED",
        title: "품질진행 순서 변경",
        message: `“${priorityName(firmwareId)}”과 “${priorityName(displacedId)}” 순서가 변경되었습니다.`,
        developmentId: byFirmwareId.get(firmwareId)?.project.id,
      });
    }
  };

  const dropPriority = async (targetId: string, placeAfter: boolean) => {
    if (!draggingPriorityId || draggingPriorityId === targetId) {
      setDraggingPriorityId(null);
      return;
    }
    const nextIds = priorityIds.filter((id) => id !== draggingPriorityId);
    const targetIndex = nextIds.indexOf(targetId);
    nextIds.splice(targetIndex + (placeAfter ? 1 : 0), 0, draggingPriorityId);
    const movedId = draggingPriorityId;
    setDraggingPriorityId(null);
    const saved = await savePriorityOrder(nextIds, "우선순위 순서를 저장했습니다.");
    if (saved) {
      await createActivityNotification({
        action: "QA_PRIORITY_REORDERED",
        title: "품질진행 순서 변경",
        message: `“${priorityName(movedId)}”과 “${priorityName(targetId)}” 순서가 변경되었습니다.`,
        developmentId: byFirmwareId.get(movedId)?.project.id,
      });
    }
  };

  const removePriority = async (firmwareId: string) => {
    const saved = await savePriorityOrder(
      priorityIds.filter((itemId) => itemId !== firmwareId),
      "우선순위에서 제외했습니다.",
    );
    if (saved) {
      await createActivityNotification({
        action: "QA_PRIORITY_REMOVED",
        title: "품질진행 목록 수정",
        message: `“${priorityName(firmwareId)}” 품질 테스트가 목록에서 제외되었습니다.`,
        developmentId: byFirmwareId.get(firmwareId)?.project.id,
      });
    }
  };

  const unreadNotificationIds = new Set(readNotificationIds);
  const unreadCount = notifications.filter((item) => !unreadNotificationIds.has(item.id)).length;

  if (loading) {
    return (
      <main className="loading-screen">
        <span className="loading-mark">M</span>
        <p>개발 일정을 불러오고 있습니다.</p>
      </main>
    );
  }

  if (isSupabaseConfigured && !userEmail) {
    return <LoginScreen onSuccess={(email) => setUserEmail(email)} />;
  }

  if (loadError) return <main className="loading-screen"><p role="alert">{loadError}</p><button onClick={() => window.location.reload()}>다시 불러오기</button></main>;

  return (
    <main className="app-shell">
      <aside className="sidebar" inert={showForm || showIssueForm}>
        <div className="brand">
          <span className="brand-mark">M</span>
          <div><strong>MYBI</strong><small>개발업무관리</small></div>
        </div>
        <nav className="main-nav" aria-label="주요 메뉴">
          {menuItems.map((item) => (
            <button
              className={activeView === item.id ? "active" : ""}
              key={item.id}
              onClick={() => {
                setSelectedIssueId(null);
                setActiveView(item.id);
                setSelectedId(null);
              }}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="account-menu" onClick={handleLogout}>
            <span aria-hidden="true">⇥</span> 로그아웃
          </button>
          <div className="sidebar-bottom">
            <div className="user-card">
              <span className="avatar">{(userEmail ?? "조준우").slice(0, 1).toUpperCase()}</span>
              <div><strong>{userEmail ? userEmail.split("@")[0] : "조준우"}</strong><small>PM / 매니저</small></div>
            </div>
            {userId && <button type="button" className="settings-button password-shortcut" aria-haspopup="dialog"
              onClick={() => setPasswordAccountId(userId)}>비밀번호 변경</button>}
          </div>
        </div>
      </aside>

      <section inert={showForm || Boolean(selected) || showIssueForm || Boolean(selectedIssue)} className={`workspace ${activeView === "dashboard" ? "dashboard-workspace" : ""}`}>
        <header className="topbar">
          <div>
            <p className="eyebrow">차량내디바이스팀</p>
            <h1>{activeView === "priority" ? "우선 순위" : activeView === "issues" ? "이슈사항" : "개발 일정 대시보드"}</h1>
          </div>
          <div className="top-actions">
            {userId && <button type="button" className="password-shortcut compact-password-shortcut" aria-haspopup="dialog"
              onClick={() => setPasswordAccountId(userId)}>비밀번호 변경</button>}
            <span className={`mode-pill ${isSupabaseConfigured ? "db" : "demo"}`}>
              <i /> {isSupabaseConfigured ? "DB 연결" : "데모 모드"}
            </span>
            <div className="notification-wrapper">
              <button
                className={`icon-button notification-button ${showNotifications ? "active" : ""}`}
                aria-label={`알림 ${unreadCount}건`}
                aria-expanded={showNotifications}
                onClick={() => setShowNotifications((current) => !current)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
                </svg>
                {unreadCount > 0 && (
                  <span className="notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
                )}
              </button>
              {showNotifications && (
                <NotificationPopover
                  items={notifications}
                  readIds={unreadNotificationIds}
                  onOpen={openNotification}
                  onReadAll={() => storeReadNotificationIds(notifications.map((item) => item.id))}
                  onClose={() => setShowNotifications(false)}
                />
              )}
            </div>
            {activeView === "dashboard" ? (
              <button className="primary-button" onClick={() => { setEditingDevelopment(null); setShowForm(true); }}><span>＋</span> 개발 등록</button>
            ) : activeView === "priority" ? (
              <button className="primary-button" onClick={() => setShowPriorityPicker(true)}><span>＋</span> 우선순위 추가</button>
            ) : (
              <button className="primary-button" onClick={() => setShowIssueForm(true)}><span>＋</span> 이슈사항 추가</button>
            )}
          </div>
        </header>

        {activeView === "dashboard" ? <>
          <section className="stat-grid" aria-label="일정 요약">
            <StatCard label="전체 개발" value={periodRows.length} helper="조회 기간 기준" tone="navy" icon="▦" />
            <StatCard label="진행중" value={activeCount} helper="건 수" tone="blue" icon="▶" />
            <StatCard label="완료" value={completedCount} helper="건 수" tone="green" icon="✓" />
            <StatCard label="지연" value={delayedCount} helper="건 수" tone="red" icon="↗" />
          </section>

          <section className="schedule-card">
          <div className="schedule-toolbar">
            <div className="month-control">
              <button onClick={() => changePeriod(-1)} aria-label={annual ? "이전 연도" : "이전 달"}
                disabled={calendar.start === "1000-01-01"}>‹</button>
              <select aria-label="조회 연도" value={selectedYear} onChange={event => setMonth(new Date(Number(event.target.value), month.getMonth(), 1))}>
                {years.map(year => <option key={year} value={year}>{year}년</option>)}
              </select>
              {!annual && <select aria-label="조회 월" value={month.getMonth() + 1}
                onChange={event => setMonth(new Date(selectedYear, Number(event.target.value) - 1, 1))}>
                {Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{index + 1}월</option>)}
              </select>}
              <button onClick={() => changePeriod(1)} aria-label={annual ? "다음 연도" : "다음 달"}
                disabled={calendar.end === "9999-12-31"}>›</button>
              <button className="today-button" onClick={() => {
                const current = new Date();
                setMonth(new Date(current.getFullYear(), current.getMonth(), 1));
              }}>오늘</button>
            </div>
            <div className="schedule-actions">
              <div className="view-switch" role="group" aria-label="보기 방식">
                <button aria-pressed={annual} className={annual ? "active" : ""} onClick={() => setScheduleView("year")}>연간</button>
                <button aria-pressed={!annual} className={!annual ? "active" : ""} onClick={() => setScheduleView("month")}>월간</button>
              </div>
              <button type="button" className="schedule-export" disabled={exporting} onClick={downloadSchedule}>
                {exporting ? "내보내는 중…" : "엑셀로 내보내기"}
              </button>
            </div>
          </div>

          <div className="filter-row">
            <label className="search-box">
              <span>⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="개발명, 지역, FW 버전 검색" />
              {query && <button onClick={() => setQuery("")} aria-label="검색어 지우기">×</button>}
            </label>
            <MultiFilterSelect label="구분" allLabel="전체 구분" values={categoryFilters} onChange={setCategoryFilters} options={["프로젝트", "유지보수"]} />
            <MultiFilterSelect label="담당자" allLabel="전체 담당자" values={assigneeFilters} onChange={setAssigneeFilters} options={assignees} />
            <MultiFilterSelect label="진행상태" values={progressFilters} onChange={setProgressFilters} options={progressStates} />
            {undatedCount > 0 && <label className="undated-filter">
              <input type="checkbox" checked={includeUndated} onChange={event => setIncludeUndated(event.target.checked)} />
              일정 미정 포함
            </label>}
          </div>

          <div className="legend-row">
            {filtered.some(({ businessPeriod }) => businessPeriod && overlaps(businessPeriod, calendar)) &&
              <span><i className="business" />사업기간</span>}
            {firmwareStages.map(stage => <span key={stage.type}><i className={stage.type} />{stage.label}</span>)}
            <em>총 {filtered.length}건</em>
          </div>

          <div className="gantt-scroll">
            <div className={`gantt ${annual ? "gantt-year" : ""}`} style={{ "--day-count": calendar.columns.length,
              "--calendar-columns": calendar.columns.map(column => column.days + "fr").join(" ") } as React.CSSProperties}>
              <div className="gantt-calendar-head">
                <div className="gantt-head sticky-info">
                  <span>개발 업무</span><span>담당 / 공정률</span>
                </div>
                <div className="day-heads">
                  {calendar.columns.map(column => <span key={column.label} className={`${column.weekend ? "weekend" : ""} ${column.current ? "today" : ""}`}>
                    {column.weekday && <small>{column.weekday}</small>}{column.label}
                  </span>)}
                </div>
              </div>
              {filtered.length ? filtered.map(({item, businessPeriod, progress}) => (
                <TimelineRow key={item.id} item={item} progress={progress} businessPeriod={businessPeriod} calendar={calendar}
                  selected={item.id === selectedId} onSelect={() => setSelectedId(item.id)} />
              )) : (
                <div className="empty-row">조건에 맞는 개발 건이 없습니다. 필터를 다시 확인해주세요.</div>
              )}
            </div>
          </div>
          </section>
        </> : activeView === "priority" ? (
          <PriorityBoard
            items={priorityItems}
            draggingId={draggingPriorityId}
            onAdd={() => setShowPriorityPicker(true)}
            onDragStart={setDraggingPriorityId}
            onDragEnd={() => setDraggingPriorityId(null)}
            onDrop={dropPriority}
            onMove={movePriority}
            onRemove={removePriority}
          />
        ) : (
          <IssueBoard
            issues={issues}
            loadError={issueListError}
            onOpen={setSelectedIssueId}
            onAdd={() => setShowIssueForm(true)}
            onRemove={removeIssue}
          />
        )}
      </section>

      {selected && !showForm && (
        <DetailPanel key={selected.id}
          item={selected}
          onStatusChange={saveRowStatus}
          onClose={() => setSelectedId(null)}
          onDelete={deleteDevelopment}
          onEdit={() => { setEditingDevelopment(selected); setShowForm(true); }}
        />
      )}
      {showForm && (
        <DevelopmentForm
          item={editingDevelopment}
          items={items}
          onClose={() => { setShowForm(false); setEditingDevelopment(null); }}
          onSave={saveDevelopment}
        />
      )}
      {showPriorityPicker && (
        <PriorityPicker
          items={priorityCandidates}
          onClose={() => setShowPriorityPicker(false)}
          onConfirm={addPriorityItems}
        />
      )}
      {selectedIssue && (
        <IssueDetail key={selectedIssue.id} issue={selectedIssue} editing={showIssueForm}
          onClose={() => setSelectedIssueId(null)} onEdit={() => setShowIssueForm(true)} />
      )}
      {showIssueForm && (
        <IssueForm issue={selectedIssue}
          onClose={() => setShowIssueForm(false)}
          onSave={saveIssue}
        />
      )}
      {userEmail && userId && passwordAccountId === userId && (
        <PasswordDialog key={userId} userId={userId} email={userEmail} onClose={() => setPasswordAccountId(null)}
          onSaved={() => { setPasswordAccountId(null); showMessage("비밀번호를 변경했습니다."); }} />
      )}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}

function StatCard({ label, value, helper, tone, icon }: { label: string; value: number; helper: string; tone: string; icon: string }) {
  return <article className={`stat-card ${tone}`}><span className="stat-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{helper}</small></div></article>;
}

function NotificationPopover({ items, readIds, onOpen, onReadAll, onClose }: {
  items: AppNotification[];
  readIds: Set<string>;
  onOpen: (notification: AppNotification) => void;
  onReadAll: () => void;
  onClose: () => void;
}) {
  const unreadCount = items.filter((item) => !readIds.has(item.id)).length;
  return (
    <section className="notification-popover" aria-label="알림 목록">
      <header>
        <div><strong>알림</strong><span>{unreadCount}건 읽지 않음</span></div>
        <button type="button" onClick={onClose} aria-label="알림 닫기">×</button>
      </header>
      {items.length ? (
        <div className="notification-list">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              className={readIds.has(item.id) ? "read" : "unread"}
              onClick={() => onOpen(item)}
            >
              <i aria-hidden="true" />
              <span>
                <strong>{item.title}</strong>
                <small>{item.message}</small>
                <em>{formatNotificationTime(item.createdAt)}</em>
              </span>
              <b aria-hidden="true">›</b>
            </button>
          ))}
        </div>
      ) : (
        <div className="notification-empty"><span>✓</span><strong>새 알림이 없습니다.</strong><small>개발업무와 품질진행 변경사항이 여기에 표시됩니다.</small></div>
      )}
      {items.length > 0 && (
        <footer><button type="button" onClick={onReadAll} disabled={!unreadCount}>모두 읽음으로 표시</button></footer>
      )}
    </section>
  );
}

function PriorityBoard({ items, draggingId, onAdd, onDragStart, onDragEnd, onDrop, onMove, onRemove }: {
  items: PriorityEntry[];
  draggingId: string | null;
  onAdd: () => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDrop: (id: string, placeAfter: boolean) => void;
  onMove: (id: string, offset: number) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <section className="priority-board" aria-labelledby="priority-title">
      <header className="priority-board-head">
        <div>
          <p>QUALITY TEST PRIORITY</p>
          <h2 id="priority-title">품질 테스트 우선순위</h2>
          <small>카드를 마우스로 잡아 위아래로 이동하면 테스트 순서가 저장됩니다.</small>
        </div>
        <span>총 {items.length}건</span>
      </header>
      {items.length ? (
        <div className="priority-list">
          {items.map(({ project, fw }, index) => {
            return (
              <article
                key={fw.id}
                className={`priority-card fw-priority-card ${draggingId === fw.id ? "dragging" : ""}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  onDragStart(fw.id);
                }}
                onDragEnd={onDragEnd}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onDrop(fw.id, event.clientY > bounds.top + bounds.height / 2);
                }}
              >
                <span className="priority-rank">{index + 1}</span>
                <span className="drag-handle" aria-hidden="true">⠿</span>
                <PrioritySummary project={project} fw={fw} />
                <div className="priority-card-actions">
                  <button onClick={() => onMove(fw.id, -1)} disabled={index === 0} aria-label={`${project.name} ${fw.kind} ${fw.version} 위로 이동`}>↑</button>
                  <button onClick={() => onMove(fw.id, 1)} disabled={index === items.length - 1} aria-label={`${project.name} ${fw.kind} ${fw.version} 아래로 이동`}>↓</button>
                  <button className="remove" onClick={() => onRemove(fw.id)} aria-label={`${project.name} ${fw.kind} ${fw.version} 우선순위에서 제외`}>×</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="priority-empty">
          <span aria-hidden="true">↕</span>
          <strong>등록된 품질 테스트 우선순위가 없습니다.</strong>
          <small>‘우선순위 추가’를 눌러 품질진행 상태의 FW를 선택하세요.</small>
          <button className="primary-button" onClick={onAdd}><span>＋</span> 우선순위 추가</button>
        </div>
      )}
    </section>
  );
}

function IssueBoard({ issues, loadError, onOpen, onAdd, onRemove }: {
  loadError: string;
  onOpen: (id: string) => void;
  issues: Issue[];
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <section className="priority-board" aria-labelledby="issue-title">
      <header className="priority-board-head issue-board-head">
        <div>
          <p>ISSUE MANAGEMENT</p>
          <h2 id="issue-title">이슈사항</h2>
          <small>개발업무별 주요 이슈와 처리상태를 관리합니다.</small>
        </div>
        <span>총 {issues.length}건</span>
      </header>
      {loadError ? <p className="form-error" role="alert">{loadError}</p> : issues.length ? (
        <div className="priority-list">
          {issues.map((issue, index) => {
            return (
              <article key={issue.id} className="priority-card issue-card">
                <span className="priority-rank issue-rank">{index + 1}</span>
                <span className="drag-handle issue-mark" aria-hidden="true">!</span>
                <div className="priority-card-body">
                  <div className="priority-card-title">
                    <div>
                      <button className="issue-open" onClick={() => onOpen(issue.id)} aria-label={`${issue.title} 상세 보기`}>{issue.title}</button>
                    </div>
                    <span className={`issue-status issue-status-${issue.status}`}>{issue.status}</span>
                  </div>
                  {issue.content && <p className="issue-content">{issue.content}</p>}
                  <dl>
                    <div><dt>중요도</dt><dd className={`issue-severity issue-severity-${issue.severity}`}>{issue.severity}</dd></div>
                    <div><dt>완료 예정</dt><dd>{issue.dueDate ?? "미정"}</dd></div>
                  </dl>
                </div>
                <div className="priority-card-actions issue-card-actions">
                  <button className="remove" onClick={() => onRemove(issue.id)} aria-label={`${issue.title} 삭제`}>×</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="priority-empty issue-empty">
          <span aria-hidden="true">!</span>
          <strong>등록된 이슈사항이 없습니다.</strong>
          <small>‘이슈사항 추가’를 눌러 개발업무의 주요 이슈를 등록하세요.</small>
          <button className="primary-button" onClick={onAdd}><span>＋</span> 이슈사항 추가</button>
        </div>
      )}
    </section>
  );
}

function IssueForm({ issue, onClose, onSave }: {
  issue?: Issue;
  onClose: () => void;
  onSave: (issue: Issue) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(issue?.title ?? "");
  const [content, setContent] = useState(issue?.content ?? "");
  const [severity, setSeverity] = useState<IssueSeverity>(issue?.severity ?? "보통");
  const [status, setStatus] = useState<IssueStatus>(issue?.status ?? "등록");
  const [dueDate, setDueDate] = useState(issue?.dueDate ?? "");
  const [id] = useState(() => issue?.id ?? uuidv4());
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !title.trim()) return;
    setSaving(true);
    const now = new Date().toISOString();
    await onSave({
      id,
      title: title.trim(),
      content: content.trim(),
      severity,
      status,
      dueDate: dueDate || undefined,
      createdAt: issue?.createdAt ?? now,
      updatedAt: now,
    });
    setSaving(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => !saving && event.target === event.currentTarget && onClose()}>
      <form className={`priority-picker issue-form${issue ? " issue-edit-form" : ""}`} role="dialog" aria-modal="true" aria-labelledby="issue-form-title" onKeyDown={e => { if (e.key === "Escape" && !saving) onClose(); }} onSubmit={submit}>
        <header>
          <h2 id="issue-form-title">{issue ? "이슈사항 수정" : "이슈사항 추가"}</h2>
          <button type="button" disabled={saving} onClick={onClose} aria-label="팝업 닫기">×</button>
        </header>
        <div className="issue-form-fields">
          <label className="wide"><span>이슈 제목</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="이슈 제목을 입력하세요" required /></label>
          <label className="wide"><span>상세 내용</span><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="현상, 영향도, 대응내용 등을 입력하세요" rows={4} /></label>
          <label><span>중요도</span><select value={severity} onChange={(event) => setSeverity(event.target.value as IssueSeverity)}>{(["긴급", "높음", "보통", "낮음"] as IssueSeverity[]).map((value) => <option key={value}>{value}</option>)}</select></label>
          <label><span>처리상태</span><select value={status} onChange={(event) => setStatus(event.target.value as IssueStatus)}>{(["등록", "처리중", "해결", "보류"] as IssueStatus[]).map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="wide"><span>완료 예정일</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
        </div>
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>취소</button>
          <button className="solid" disabled={!title.trim() || saving}>{saving ? "저장 중..." : issue ? "저장" : "등록"}</button>
        </footer>
      </form>
    </div>
  );
}

function PriorityPicker({ items, onClose, onConfirm }: {
  items: PriorityEntry[];
  onClose: () => void;
  onConfirm: (ids: string[]) => Promise<void>;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const toggle = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedIds.length) return;
    setSaving(true);
    await onConfirm(selectedIds);
    setSaving(false);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="priority-picker fw-picker" onSubmit={submit}>
        <header>
          <div><span>ADD QA PRIORITY</span><h2>우선순위 추가</h2><p>진행사항이 ‘품질진행’인 FW를 선택하세요.</p></div>
          <button type="button" onClick={onClose} aria-label="팝업 닫기">×</button>
        </header>
        <div className="priority-picker-list">
          {items.length ? items.map(({ project, fw }) => {
            const checked = selectedIds.includes(fw.id);
            return (
              <label key={fw.id} className={checked ? "checked" : ""}>
                <input type="checkbox" checked={checked} onChange={() => toggle(fw.id)} />
                <span className="checkmark">✓</span>
                <PrioritySummary project={project} fw={fw} />
              </label>
            );
          }) : (
            <div className="priority-picker-empty"><span>✓</span><strong>추가 가능한 FW가 없습니다.</strong><small>이미 등록된 FW와 품질진행 전후의 FW는 목록에서 제외됩니다.</small></div>
          )}
        </div>
        <footer>
          <span>{selectedIds.length}건 선택</span>
          <button type="button" onClick={onClose}>취소</button>
          <button className="solid" disabled={!selectedIds.length || saving}>{saving ? "저장 중..." : "선택 완료"}</button>
        </footer>
      </form>
    </div>
  );
}

function MultiFilterSelect<T extends string>({ label, allLabel, values, onChange, options }: { label: string; allLabel?: string; values: T[]; onChange: (values: T[]) => void; options: readonly T[] }) {
  const toggle = (option: T) => {
    onChange(values.includes(option) ? values.filter((value) => value !== option) : [...values, option]);
  };
  const summary = values.length === 0 ? label : values.length === 1 ? values[0] : `${label} ${values.length}개`;

  return (
    <details className="multi-filter" name="dashboard-filters">
      <summary className={values.length ? "filtered" : ""}><span>{summary}</span><i aria-hidden="true">⌄</i></summary>
      <div className="multi-filter-menu" role="group" aria-label={`${label} 필터`}>
        {allLabel && <>
          <label className={!values.length ? "checked" : ""}>
            <input type="checkbox" checked={!values.length} onChange={() => onChange([])} />
            <span className="multi-check">✓</span><em>{allLabel}</em>
          </label>
          <div className="multi-filter-divider" />
        </>}
        {options.map((option) => {
          const checked = values.includes(option);
          return (
            <label key={option} className={checked ? "checked" : ""}>
              <input type="checkbox" checked={checked} onChange={() => toggle(option)} />
              <span className="multi-check">✓</span><em>{option}</em>
            </label>
          );
        })}
      </div>
    </details>
  );
}

function ProjectProgress({ value }: { value: number }) {
  return <div className="project-progress"><span>공정률</span><progress aria-label="프로젝트 공정률" max={100} value={value} /><strong>{value}%</strong></div>;
}

function DetailPanel({ item, onClose, onDelete, onEdit, onStatusChange }: {
  item: Development; onClose: () => void; onDelete: (item: Development) => void; onEdit: () => void;
  onStatusChange: (project: Development, change: ProjectRowChange) => Promise<void>;
}) {
  const [pending, setPending] = useState<ProjectRowChange | null>(null);
  const display = pending ? withRowStatus(item, pending) : item;
  const busy = pending !== null;
  const progress = projectProgress(display);
  async function changeStatus(change: ProjectRowChange) {
    if (pending) return;
    setPending(change);
    try { await onStatusChange(item, change); } finally { setPending(null); }
  }
  return (
    <aside className="detail-panel" aria-label="개발 상세">
      <div className="detail-head">
        <div><span className="detail-code">{item.code}</span><h2>{item.name}</h2></div>
        <button onClick={onClose} aria-label="상세 닫기">×</button>
      </div>
      <ProjectProgress value={progress} />
      <div className="detail-scroll project-columns">
        <section className="detail-section project-basics">
          <h3>기본 정보</h3>
          <dl className="detail-grid">
            <div><dt>고객사</dt><dd>{item.customer}</dd></div><div><dt>지역</dt><dd>{item.region}</dd></div>
            <div className="wide"><dt>개발 구분</dt><dd>{item.category}</dd></div>
            <div className="wide"><dt>담당자</dt><dd>{item.assignees.join(" · ")}</dd></div>
            <div className="wide"><dt>배포 예정일</dt><dd>{item.deploymentDate ?? "미정"}</dd></div>
          </dl>
        </section>
        <div className="project-main">
          <section className="detail-section"><h3>개발 요약</h3><p className="body-copy">{item.summary}</p></section>
          <section className="detail-section">
            <h3>필요사항 <small>{item.requirements.length}건</small></h3>
            <RequirementTable rows={display.requirements} busy={busy}
              onStatus={(id, status) => void changeStatus({ type: "requirement", id, status })} />
          </section>
          <section className="detail-section">
            <h3>개발 FW <small>{item.firmware.length}건</small></h3>
            <FirmwareDetails item={display} busy={busy}
              onStatus={(id, status) => void changeStatus({ type: "firmware", id, status })} />
          </section>
          <section className="detail-section">
            <h3>공수 <small>합계 {totalEffort(item.effort)} MD</small></h3>
            <EffortFields effort={item.effort} />
          </section>
        </div>
      </div>
      <div className="detail-actions">{busy && <span role="status">진행사항 저장 중…</span>}
        <button className="danger" onClick={() => onDelete(item)} disabled={busy}>삭제</button>
        <button className="solid" onClick={onEdit} disabled={busy}>수정</button></div>
    </aside>
  );
}

function DevelopmentForm({ item, items, onClose, onSave }: { item: Development | null; items: Development[]; onClose: () => void; onSave: (item: Development) => Promise<boolean> }) {
  const [saving, setSaving] = useState(false);
  const [scheduleConflicts, setScheduleConflicts] = useState<Development[]>([]);
  const [pendingDevelopment, setPendingDevelopment] = useState<Development | null>(null);
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState(() => {
    return {
      name: item?.name ?? "",
      customer: item?.customer ?? "사업팀",
      region: item?.region ?? "",
      category: item?.category ?? "프로젝트" as Development["category"],
      assignee: item?.assignees.join(", ") ?? "담당자",
      summary: item?.summary ?? "",
    };
  });

  const [requirements, setRequirements] = useState<Requirement[]>(() =>
    item?.requirements.length ? item.requirements : [emptyRequirement(uuidv4())]);
  const [rows, setRows] = useState<Firmware[]>(() => item?.firmware ?? [emptyFirmware(uuidv4())]);
  const [effort, setEffort] = useState<Effort>(() => item?.effort ?? emptyEffort());
  const firmware = rows.map(fw => ({ ...fw, version: fw.version.trim(), region: fw.region.trim() }))
    .filter(fw => item?.firmware.some(old => old.id === fw.id) ||
      fw.region || fw.kind || fw.version || firmwareStages.some(stage => fw[stage.start] || fw[stage.end]) || fw.status !== "대기중");
  const deploymentDate = deploymentAfterQuality(firmware);
  const progress = projectProgress({ id: item?.id ?? "", status: item?.status ?? "대기중", phases: item?.phases ?? [], firmware, effort });
  const buildDevelopment = () => {
    for (const [index, fw] of firmware.entries()) {
      for (const stage of firmwareStages) {
        const start = fw[stage.start];
        const end = fw[stage.end];
        if (Boolean(start) !== Boolean(end) || start > end) {
          setFormError(`FW ${index + 1}행의 ${stage.label} 시작일과 종료일을 확인해주세요.`);
          return null;
        }
      }
    }
    setFormError("");
    return {
      id: item?.id ?? uuidv4(),
      code: item?.code ?? createCode(items),
      name: form.name.trim(),
      customer: form.customer.trim(),
      region: form.region.trim(),
      category: form.category,
      status: item?.status ?? "대기중",
      summary: form.summary.trim(),
      requirements: requirements.filter(r => item?.requirements.some(old => old.id === r.id) ||
        r.kind.trim() || r.detail.trim() || r.reason.trim() || r.scheduledOn || r.status !== "자료요청"),
      assignees: form.assignee.split(",").map((name) => name.trim()).filter(Boolean),
      deploymentDate,
      phases: item?.phases ?? [],
      firmware,
      effort,
      updatedAt: item?.updatedAt ?? new Date().toISOString(),
    } satisfies Development;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.region.trim()) return;
    const development = buildDevelopment();
    if (!development) return;
    setSaving(true);
    const conflicts = findScheduleConflicts(development, items);
    if (conflicts.length) {
      setPendingDevelopment(development);
      setScheduleConflicts(conflicts);
      setSaving(false);
      return;
    }
    if (await onSave(development)) onClose();
    setSaving(false);
  };
  const saveWithConflicts = async () => {
    if (!pendingDevelopment) return;
    setSaving(true);
    if (await onSave(pendingDevelopment)) onClose();
    setSaving(false);
  };
  const set = (key: keyof typeof form, value: string | number) => setForm((current) => ({ ...current, [key]: value }));
  const isEditing = Boolean(item);
  return (
    <div className="project-editor-backdrop">
      <form className="development-form" role="dialog" aria-modal="true" aria-label={isEditing ? "개발업무 수정" : "새 개발 건 등록"} onSubmit={submit}>
        <header><div><span>{isEditing ? `EDIT DEVELOPMENT · ${item?.code}` : "NEW DEVELOPMENT"}</span><h2>{isEditing ? "개발업무 수정" : "새 개발 건 등록"}</h2><p>프로젝트 정보와 FW별 일정, 공수를 입력합니다.</p></div><button type="button" aria-label="등록 창 닫기" onClick={onClose}>×</button></header>
        <ProjectProgress value={progress} />
        <div className="form-scroll project-columns">
          <fieldset className="project-basics"><legend>기본 정보</legend><div className="form-grid">
            <label className="wide">개발명 <input autoFocus required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="예: 부산 승하차단말기 8BIN 적용" /></label>
            <label>고객사 <input value={form.customer} onChange={(e) => set("customer", e.target.value)} /></label>
            <label>지역 <input required value={form.region} onChange={(e) => set("region", e.target.value)} placeholder="예: 부산" /></label>
            <label>개발 구분 <select value={form.category} onChange={(e) => set("category", e.target.value)}><option>프로젝트</option><option>유지보수</option></select></label>
            <label>배포 일정 <input readOnly value={deploymentDate ?? "미정"} aria-label="배포 일정" /><small>마지막 품질 종료일의 다음 평일에 자동 산정</small></label>
            <label className="wide">담당자 <input value={form.assignee} onChange={(e) => set("assignee", e.target.value)} placeholder="여러 명은 쉼표로 구분" /><small>여러 명은 쉼표(,)로 구분하세요.</small></label>
          </div></fieldset>
          <div className="project-main">
            <div className="form-grid project-description">
              <label className="wide">개발 요약 <textarea className="project-summary-input" value={form.summary} onChange={(e) => set("summary", e.target.value)} rows={7} placeholder="개발 목적과 핵심 내용을 적어주세요." /></label>
            </div>
            <fieldset><legend>필요사항</legend><RequirementTable rows={requirements} onChange={setRequirements} /></fieldset>
            <FirmwareEditor rows={rows} onChange={setRows} />
            <fieldset><legend>공수 <small>합계 {totalEffort(effort)} MD</small></legend><EffortFields effort={effort} onChange={setEffort} /></fieldset>
            {formError && <p className="form-error" role="alert">{formError}</p>}
          </div>
        </div>
        <footer><button type="button" onClick={onClose}>취소</button><button className="solid" disabled={saving}>{saving ? "저장 중..." : isEditing ? "저장" : "개발 건 등록"}</button></footer>
      </form>
      {pendingDevelopment && scheduleConflicts.length > 0 && (
        <div className="conflict-backdrop">
          <section className="conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title">
            <header><span aria-hidden="true">!</span><div><small>SCHEDULE OVERLAP</small><h3 id="conflict-title">중복 일정 {scheduleConflicts.length}건이 있습니다.</h3></div></header>
            <p><strong>{pendingDevelopment.name}</strong>의 일정과 아래 개발업무가 겹칩니다.</p>
            <div className="conflict-list">
              {scheduleConflicts.map((item) => (
                <article key={item.id}>
                  <div><strong>{item.name}</strong><small>{item.code} · 공정률 {projectProgress(item)}%</small></div>
                  <span>{dateRange(item)}</span>
                </article>
              ))}
            </div>
            <footer>
              <button type="button" onClick={() => { setPendingDevelopment(null); setScheduleConflicts([]); }}>일정 다시 확인</button>
              <button type="button" className="solid warning" disabled={saving} onClick={saveWithConflicts}>{saving ? "저장 중..." : isEditing ? "그래도 저장" : "그래도 등록"}</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError("");
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) setError("이메일 또는 비밀번호를 확인해주세요.");
    else if (data.user.email) {
      onSuccess(data.user.email);
      window.location.reload();
    }
    setSubmitting(false);
  };
  return <main className="login-page"><section className="login-brand"><span className="brand-mark large">M</span><p>MYBI INFRA</p><h1>개발의 흐름을<br />한눈에 관리하세요.</h1><small>사업 · 개발 · 품질 일정을 하나의 화면에서 공유합니다.</small></section><form className="login-card" onSubmit={submit}><span>INTERNAL WORKSPACE</span><h2>로그인</h2><p>관리자가 등록한 계정으로 접속해주세요.</p><label>이메일<input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></label><label>비밀번호<input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="비밀번호 입력" /></label>{error && <em>{error}</em>}<button disabled={submitting}>{submitting ? "확인 중..." : "로그인"}</button></form></main>;
}
