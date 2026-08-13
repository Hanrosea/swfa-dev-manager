"use client";

import { v4 as uuidv4 } from "uuid";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { initialDevelopments } from "@/lib/mock-data";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  AppNotification,
  Development,
  DevelopmentStatus,
  NotificationAction,
  Phase,
  PhaseType,
} from "@/lib/types";

const STORAGE_KEY = "mybi-infra-dev-manager-v1";
const PRIORITY_STORAGE_KEY = "mybi-infra-qa-priority-v1";
const NOTIFICATION_STORAGE_KEY = "mybi-infra-notifications-v1";
const READ_NOTIFICATION_STORAGE_KEY = "mybi-infra-read-notifications-v1";
const notificationActions: NotificationAction[] = [
  "DEVELOPMENT_CREATED",
  "DEVELOPMENT_UPDATED",
  "QA_PRIORITY_ADDED",
  "QA_PRIORITY_REORDERED",
  "QA_PRIORITY_REMOVED",
];
const statusOptions: DevelopmentStatus[] = [
  "대기중",
  "개발진행",
  "품질진행",
  "완료",
];

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

const phaseMeta: Record<PhaseType, { label: string; short: string }> = {
  BUSINESS: { label: "사업", short: "사" },
  DEVELOPMENT: { label: "개발", short: "개" },
  QA: { label: "품질", short: "품" },
  DEPLOY: { label: "배포", short: "배" },
};

const menuItems = [
  { id: "dashboard", label: "일정 대시보드", icon: "▦" },
  { id: "developments", label: "전체 개발", icon: "≡" },
  { id: "priority", label: "우선 순위", icon: "↕" },
] as const;

function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function formatShortDate(value?: string) {
  if (!value) return "-";
  const [, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function weightedProgress(item: Development) {
  const md = item.phases.reduce((sum, phase) => sum + phase.md, 0);
  if (!md) return 0;
  return Math.round(
    item.phases.reduce((sum, phase) => sum + phase.md * phase.progress, 0) / md,
  );
}

function dateRange(item: Development) {
  const dates = item.phases.flatMap((phase) => [phase.start, phase.end]).sort();
  return `${formatShortDate(dates[0])} ~ ${formatShortDate(dates.at(-1))}`;
}

function scheduleBounds(item: Development) {
  const dates = item.phases.flatMap((phase) => [phase.start, phase.end]).sort();
  return { start: dates[0] ?? "", end: dates.at(-1) ?? "" };
}

function findScheduleConflicts(candidate: Development, items: Development[]) {
  const candidateRange = scheduleBounds(candidate);
  return items.filter((item) => {
    const range = scheduleBounds(item);
    return Boolean(
      candidateRange.start &&
      candidateRange.end &&
      range.start &&
      range.end &&
      candidateRange.start <= range.end &&
      candidateRange.end >= range.start,
    );
  });
}

function describeDevelopmentChange(before: Development, after: Development) {
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`개발명: ${before.name} → ${after.name}`);
  if (before.status !== after.status) changes.push(`상태: ${before.status} → ${after.status}`);
  if (dateRange(before) !== dateRange(after)) {
    changes.push(`일정: ${dateRange(before)} → ${dateRange(after)}`);
  }
  if (before.assignees.join("|") !== after.assignees.join("|")) {
    changes.push(`담당자: ${after.assignees.join(", ") || "미지정"}`);
  }
  if (before.summary !== after.summary || before.requirements !== after.requirements) {
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

function phasesForStatus(phases: Phase[], status: DevelopmentStatus) {
  return phases.map((phase) => {
    const progress = Math.min(100, Math.max(0, Number(phase.progress) || 0));
    if (status === "완료") return { ...phase, progress: 100 };
    if (status === "품질진행" && ["BUSINESS", "DEVELOPMENT"].includes(phase.type)) {
      return { ...phase, progress: 100 };
    }
    if (status === "개발진행" && phase.type === "BUSINESS") {
      return { ...phase, progress: 100 };
    }
    return { ...phase, progress };
  });
}

function normalizeDevelopment(item: Development): Development {
  const status = normalizeStatus(item.status);
  return {
    ...item,
    status,
    phases: phasesForStatus(item.phases ?? [], status),
  };
}

function mapDatabaseRow(row: Record<string, unknown>): Development {
  const phases = (row.development_phases as Record<string, unknown>[] | null) ?? [];
  return normalizeDevelopment({
    id: String(row.id),
    code: String(row.development_code),
    name: String(row.name),
    customer: String(row.customer ?? ""),
    region: String(row.region ?? ""),
    category: row.category as Development["category"],
    status: normalizeStatus(row.status),
    summary: String(row.summary ?? ""),
    requirements: String(row.requirements ?? ""),
    assignees: (row.assignee_names as string[] | null) ?? [],
    deploymentDate: row.deployment_date ? String(row.deployment_date) : undefined,
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
    phases: phases.map((phase) => ({
      id: String(phase.id),
      type: phase.phase_type as PhaseType,
      start: String(phase.planned_start),
      end: String(phase.planned_end),
      md: Number(phase.planned_md ?? 0),
      progress: Number(phase.progress ?? 0),
    })),
  });
}

export default function DevelopmentManager() {
  const [items, setItems] = useState<Development[]>(initialDevelopments);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [month, setMonth] = useState(() => {
    const current = new Date();
    return new Date(current.getFullYear(), current.getMonth(), 1);
  });
  const [query, setQuery] = useState("");
  const [statusFilters, setStatusFilters] = useState<DevelopmentStatus[]>([]);
  const [categoryFilters, setCategoryFilters] = useState<Development["category"][]>([]);
  const [assigneeFilters, setAssigneeFilters] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"dashboard" | "priority">("dashboard");
  const [priorityIds, setPriorityIds] = useState<string[]>([]);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [draggingPriorityId, setDraggingPriorityId] = useState<string | null>(null);
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
      let loadedItems = initialDevelopments;
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as Development[];
          if (Array.isArray(parsed)) {
            loadedItems = parsed.map(normalizeDevelopment);
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
              loadedItems.filter((item) => item.status === "품질진행").map((item) => item.id),
            );
            queueMicrotask(() => setPriorityIds(parsed.filter((id) => qualityIds.has(id))));
          }
        } catch {
          window.localStorage.removeItem(PRIORITY_STORAGE_KEY);
        }
      }
      return;
    }

    let mounted = true;
    const load = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!mounted) return;
      setUserEmail(sessionData.session?.user.email ?? null);
      setUserId(sessionData.session?.user.id ?? null);
      if (sessionData.session) {
        const [developmentResult, priorityResult] = await Promise.all([
          supabase
            .from("developments")
            .select("*, development_phases(*)")
            .is("deleted_at", null)
            .order("updated_at", { ascending: false }),
          supabase
            .from("qa_priorities")
            .select("development_id, sort_order")
            .order("sort_order", { ascending: true }),
        ]);
        if (!developmentResult.error) {
          const loadedItems = (developmentResult.data ?? []).map(mapDatabaseRow);
          setItems(loadedItems);
          if (!priorityResult.error) {
            const qualityIds = new Set(
              loadedItems.filter((item) => item.status === "품질진행").map((item) => item.id),
            );
            setPriorityIds(
              (priorityResult.data ?? [])
                .map((row) => String(row.development_id))
                .filter((id) => qualityIds.has(id)),
            );
          }
        }
      }
      setLoading(false);
    };
    load();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user.email ?? null);
      setUserId(session?.user.id ?? null);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    }
  }, [items]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      window.localStorage.setItem(PRIORITY_STORAGE_KEY, JSON.stringify(priorityIds));
    }
  }, [priorityIds]);

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

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesQuery =
        !normalized ||
        [item.name, item.code, item.customer, item.region, ...item.assignees]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return (
        matchesQuery &&
        (!statusFilters.length || statusFilters.includes(item.status)) &&
        (!categoryFilters.length || categoryFilters.includes(item.category)) &&
        (!assigneeFilters.length || item.assignees.some((name) => assigneeFilters.includes(name)))
      );
    });
  }, [items, query, statusFilters, categoryFilters, assigneeFilters]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const daysCount = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: daysCount }, (_, index) => index + 1);
  const today = new Date();
  const isCurrentMonth =
    month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();
  const activeCount = items.filter((item) => ["개발진행", "품질진행"].includes(item.status)).length;
  const completedCount = items.filter((item) => item.status === "완료").length;
  const delayedCount = items.filter((item) => {
    const end = item.phases.map((phase) => phase.end).sort().at(-1);
    return (
      item.status !== "완료" &&
      end &&
      end < localDate(today) &&
      weightedProgress(item) < 100
    );
  }).length;

  const changeMonth = (offset: number) => {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  };

  const showMessage = (message: string) => setToast(message);

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
      const [developmentResult, priorityResult] = await Promise.all([
        supabase
          .from("developments")
          .select("*, development_phases(*)")
          .eq("id", notification.developmentId)
          .is("deleted_at", null)
          .maybeSingle(),
        supabase
          .from("qa_priorities")
          .select("development_id, sort_order")
          .order("sort_order", { ascending: true }),
      ]);
      if (developmentResult.data) {
        const latest = mapDatabaseRow(developmentResult.data as Record<string, unknown>);
        setItems((current) => [
          latest,
          ...current.filter((item) => item.id !== latest.id),
        ]);
        const range = scheduleBounds(latest);
        if (range.start) {
          const start = new Date(`${range.start}T00:00:00`);
          setMonth(new Date(start.getFullYear(), start.getMonth(), 1));
        }
      }
      if (!priorityResult.error) {
        setPriorityIds((priorityResult.data ?? []).map((row) => String(row.development_id)));
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
    setUserEmail(null);
    setUserId(null);
    setSelectedId(null);
  };

  const saveDevelopment = async (development: Development) => {
    const previous = items.find((item) => item.id === development.id);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setItems((current) => {
        const exists = current.some((item) => item.id === development.id);
        return exists
          ? current.map((item) => (item.id === development.id ? development : item))
          : [development, ...current];
      });
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
    }

    const developmentRow = {
      id: development.id,
      development_code: development.code,
      name: development.name,
      customer: development.customer,
      region: development.region,
      category: development.category,
      status: development.status,
      summary: development.summary,
      requirements: development.requirements,
      assignee_names: development.assignees,
      deployment_date: development.deploymentDate ?? null,
    };
    const { error } = await supabase.from("developments").upsert(developmentRow);
    if (error) {
      showMessage(`저장 실패: ${error.message}`);
      return false;
    }
    await supabase.from("development_phases").delete().eq("development_id", development.id);
    const { error: phaseError } = await supabase.from("development_phases").insert(
      development.phases.map((phase) => ({
        id: phase.id,
        development_id: development.id,
        phase_type: phase.type,
        planned_start: phase.start,
        planned_end: phase.end,
        planned_md: phase.md,
        progress: phase.progress,
      })),
    );
    if (phaseError) {
      showMessage(`일정 저장 실패: ${phaseError.message}`);
      return false;
    }
    setItems((current) => {
      const exists = current.some((item) => item.id === development.id);
      return exists
        ? current.map((item) => (item.id === development.id ? development : item))
        : [development, ...current];
    });
    setSelectedId(development.id);
    await createActivityNotification({
      action: previous ? "DEVELOPMENT_UPDATED" : "DEVELOPMENT_CREATED",
      title: previous ? "개발업무 수정" : "개발업무 업로드",
      message: previous
        ? `“${development.name}” ${describeDevelopmentChange(previous, development)}`
        : `“${development.name}” 개발업무가 등록되었습니다.`,
      developmentId: development.id,
    });
    showMessage("DB에 저장했습니다.");
    return true;
  };

  const savePriorityOrder = async (ids: string[], successMessage?: string) => {
    const qualityIds = new Set(
      items.filter((item) => item.status === "품질진행").map((item) => item.id),
    );
    const nextIds = Array.from(new Set(ids)).filter((id) => qualityIds.has(id));
    const supabase = getSupabaseBrowserClient();

    if (supabase) {
      const { error: deleteError } = await supabase
        .from("qa_priorities")
        .delete()
        .gte("sort_order", 0);
      if (deleteError) {
        showMessage(`우선순위 저장 실패: ${deleteError.message}`);
        return false;
      }

      if (nextIds.length) {
        const { error: insertError } = await supabase.from("qa_priorities").insert(
          nextIds.map((developmentId, index) => ({
            development_id: developmentId,
            sort_order: index,
          })),
        );
        if (insertError) {
          showMessage(`우선순위 저장 실패: ${insertError.message}`);
          return false;
        }
      }
    }

    setPriorityIds(nextIds);
    if (successMessage) showMessage(successMessage);
    return true;
  };

  const quickStatusChange = async (status: DevelopmentStatus) => {
    if (!selected) return;
    const saved = await saveDevelopment({
      ...selected,
      status,
      phases: phasesForStatus(selected.phases, status),
      updatedAt: new Date().toISOString(),
    });
    if (saved && status !== "품질진행" && priorityIds.includes(selected.id)) {
      const removed = await savePriorityOrder(priorityIds.filter((id) => id !== selected.id));
      if (removed) {
        await createActivityNotification({
          action: "QA_PRIORITY_REMOVED",
          title: "품질진행 목록 수정",
          message: `“${selected.name}” 품질 테스트가 목록에서 제외되었습니다.`,
          developmentId: selected.id,
        });
      }
    }
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
    if (priorityIds.includes(development.id)) {
      await savePriorityOrder(priorityIds.filter((id) => id !== development.id));
    }
    setSelectedId(null);
    showMessage("개발 건을 삭제했습니다.");
  };

  const priorityItems = priorityIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is Development => Boolean(item && item.status === "품질진행"));
  const priorityCandidates = items.filter(
    (item) => item.status === "품질진행" && !priorityIds.includes(item.id),
  );

  const addPriorityItems = async (ids: string[]) => {
    const saved = await savePriorityOrder(
      [...priorityIds, ...ids],
      ids.length ? `${ids.length}건을 우선순위에 추가했습니다.` : undefined,
    );
    if (saved) {
      for (const id of ids) {
        const development = items.find((item) => item.id === id);
        if (!development) continue;
        await createActivityNotification({
          action: "QA_PRIORITY_ADDED",
          title: "품질진행 업로드",
          message: `“${development.name}” 품질 테스트가 등록되었습니다.`,
          developmentId: id,
        });
      }
      setShowPriorityPicker(false);
    }
  };

  const movePriority = async (developmentId: string, offset: number) => {
    const currentIndex = priorityIds.indexOf(developmentId);
    const nextIndex = currentIndex + offset;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= priorityIds.length) return;
    const nextIds = [...priorityIds];
    const displacedId = nextIds[nextIndex];
    [nextIds[currentIndex], nextIds[nextIndex]] = [nextIds[nextIndex], nextIds[currentIndex]];
    const saved = await savePriorityOrder(nextIds, "우선순위 순서를 저장했습니다.");
    if (saved) {
      const moved = items.find((item) => item.id === developmentId);
      const displaced = items.find((item) => item.id === displacedId);
      await createActivityNotification({
        action: "QA_PRIORITY_REORDERED",
        title: "품질진행 순서 변경",
        message: `“${moved?.name ?? "개발업무"}”과 “${displaced?.name ?? "개발업무"}” 순서가 변경되었습니다.`,
        developmentId,
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
      const moved = items.find((item) => item.id === movedId);
      const target = items.find((item) => item.id === targetId);
      await createActivityNotification({
        action: "QA_PRIORITY_REORDERED",
        title: "품질진행 순서 변경",
        message: `“${moved?.name ?? "개발업무"}”과 “${target?.name ?? "개발업무"}” 순서가 변경되었습니다.`,
        developmentId: movedId,
      });
    }
  };

  const removePriority = async (developmentId: string) => {
    const development = items.find((item) => item.id === developmentId);
    const saved = await savePriorityOrder(
      priorityIds.filter((itemId) => itemId !== developmentId),
      "우선순위에서 제외했습니다.",
    );
    if (saved) {
      await createActivityNotification({
        action: "QA_PRIORITY_REMOVED",
        title: "품질진행 목록 수정",
        message: `“${development?.name ?? "개발업무"}” 품질 테스트가 목록에서 제외되었습니다.`,
        developmentId,
      });
    }
  };

  const exportCsv = () => {
    const header = ["개발코드", "개발명", "고객사", "지역", "구분", "상태", "담당자", "진행률", "전체일정", "배포예정일"];
    const rows = filtered.map((item) => [
      item.code,
      item.name,
      item.customer,
      item.region,
      item.category,
      item.status,
      item.assignees.join(" / "),
      `${weightedProgress(item)}%`,
      dateRange(item),
      item.deploymentDate ?? "",
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `개발일정_${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showMessage("현재 목록을 CSV로 내려받았습니다.");
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

  return (
    <main className="app-shell">
      <aside className="sidebar">
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
                if (item.id === "dashboard" || item.id === "priority") {
                  setActiveView(item.id);
                  setSelectedId(null);
                  return;
                }
                showMessage("전체 개발 목록은 다음 단계에서 연결합니다.");
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
            <button className="settings-button" onClick={() => showMessage("관리자 설정은 다음 단계에서 연결합니다.")}>⚙</button>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">차량내디바이스팀</p>
            <h1>{activeView === "priority" ? "우선 순위" : "개발 일정 대시보드"}</h1>
          </div>
          <div className="top-actions">
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
              <button className="primary-button" onClick={() => setShowForm(true)}><span>＋</span> 개발 등록</button>
            ) : (
              <button className="primary-button" onClick={() => setShowPriorityPicker(true)}><span>＋</span> 우선순위 추가</button>
            )}
          </div>
        </header>

        {activeView === "dashboard" ? <>
          <section className="stat-grid" aria-label="일정 요약">
            <StatCard label="전체 개발" value={items.length} helper="등록된 개발 건" tone="navy" icon="▦" />
            <StatCard label="진행 중" value={activeCount} helper="건 수" tone="blue" icon="▶" />
            <StatCard label="완료" value={completedCount} helper="건 수" tone="green" icon="✓" />
            <StatCard label="지연" value={delayedCount} helper="건 수" tone="red" icon="↗" />
          </section>

          <section className="schedule-card">
          <div className="schedule-toolbar">
            <div className="month-control">
              <button onClick={() => changeMonth(-1)} aria-label="이전 달">‹</button>
              <strong>{month.getFullYear()}년 {month.getMonth() + 1}월</strong>
              <button onClick={() => changeMonth(1)} aria-label="다음 달">›</button>
              <button className="today-button" onClick={() => {
                const current = new Date();
                setMonth(new Date(current.getFullYear(), current.getMonth(), 1));
              }}>오늘</button>
            </div>
            <div className="view-switch" aria-label="보기 방식">
              <button className="active">월간</button><button onClick={() => showMessage("분기 보기는 2차 범위입니다.")}>분기</button>
            </div>
          </div>

          <div className="filter-row">
            <label className="search-box">
              <span>⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="개발명, 고객사, 지역 검색" />
              {query && <button onClick={() => setQuery("")} aria-label="검색어 지우기">×</button>}
            </label>
            <MultiFilterSelect label="상태" allLabel="전체 상태" values={statusFilters} onChange={setStatusFilters} options={statusOptions} />
            <MultiFilterSelect label="구분" allLabel="전체 구분" values={categoryFilters} onChange={setCategoryFilters} options={["프로젝트", "유지보수"]} />
            <MultiFilterSelect label="담당자" allLabel="전체 담당자" values={assigneeFilters} onChange={setAssigneeFilters} options={assignees} />
            <button className="export-button" onClick={exportCsv}>⇩ 내보내기</button>
          </div>

          <div className="legend-row">
            <span><i className="business" />사업</span>
            <span><i className="development" />개발</span>
            <span><i className="qa" />품질</span>
            <span><i className="deploy" />배포</span>
            <em>총 {filtered.length}건</em>
          </div>

          <div className="gantt-scroll">
            <div className="gantt" style={{ "--day-count": daysCount } as React.CSSProperties}>
              <div className="gantt-head sticky-info">
                <span>개발 업무</span><span>담당 / 상태</span>
              </div>
              <div className="day-heads">
                {days.map((day) => {
                  const date = new Date(month.getFullYear(), month.getMonth(), day);
                  const weekend = date.getDay() === 0 || date.getDay() === 6;
                  const current = isCurrentMonth && day === today.getDate();
                  return <span key={day} className={`${weekend ? "weekend" : ""} ${current ? "today" : ""}`}><small>{["일", "월", "화", "수", "목", "금", "토"][date.getDay()]}</small>{day}</span>;
                })}
              </div>

              {filtered.length ? filtered.map((item) => (
                <TimelineRow key={item.id} item={item} month={month} daysCount={daysCount} today={today} selected={item.id === selectedId} onSelect={() => setSelectedId(item.id)} />
              )) : (
                <div className="empty-row">조건에 맞는 개발 건이 없습니다. 필터를 다시 확인해주세요.</div>
              )}
            </div>
          </div>
          </section>
        </> : (
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
        )}
      </section>

      {selected && (
        <DetailPanel item={selected} onClose={() => setSelectedId(null)} onStatusChange={quickStatusChange} onDelete={deleteDevelopment} onMessage={showMessage} />
      )}
      {showForm && <DevelopmentForm items={items} onClose={() => setShowForm(false)} onSave={saveDevelopment} />}
      {showPriorityPicker && (
        <PriorityPicker
          items={priorityCandidates}
          onClose={() => setShowPriorityPicker(false)}
          onConfirm={addPriorityItems}
        />
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
  items: Development[];
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
          {items.map((item, index) => {
            const qaPhase = item.phases.find((phase) => phase.type === "QA");
            return (
              <article
                key={item.id}
                className={`priority-card ${draggingId === item.id ? "dragging" : ""}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  onDragStart(item.id);
                }}
                onDragEnd={onDragEnd}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onDrop(item.id, event.clientY > bounds.top + bounds.height / 2);
                }}
              >
                <span className="priority-rank">{index + 1}</span>
                <span className="drag-handle" aria-hidden="true">⠿</span>
                <div className="priority-card-body">
                  <div className="priority-card-title">
                    <div><strong>{item.name}</strong><small>{item.code} · {item.customer} · {item.region}</small></div>
                    <span className="status-badge status-품질진행">품질진행</span>
                  </div>
                  <dl>
                    <div><dt>품질 일정</dt><dd>{qaPhase ? `${formatShortDate(qaPhase.start)} ~ ${formatShortDate(qaPhase.end)}` : "미정"}</dd></div>
                    <div><dt>담당자</dt><dd>{item.assignees.join(" · ") || "미지정"}</dd></div>
                    <div><dt>배포 예정</dt><dd>{item.deploymentDate ?? "미정"}</dd></div>
                  </dl>
                </div>
                <div className="priority-card-actions">
                  <button onClick={() => onMove(item.id, -1)} disabled={index === 0} aria-label={`${item.name} 위로 이동`}>↑</button>
                  <button onClick={() => onMove(item.id, 1)} disabled={index === items.length - 1} aria-label={`${item.name} 아래로 이동`}>↓</button>
                  <button className="remove" onClick={() => onRemove(item.id)} aria-label={`${item.name} 우선순위에서 제외`}>×</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="priority-empty">
          <span aria-hidden="true">↕</span>
          <strong>등록된 품질 테스트 우선순위가 없습니다.</strong>
          <small>‘우선순위 추가’를 눌러 품질진행 상태의 개발 건을 선택하세요.</small>
          <button className="primary-button" onClick={onAdd}><span>＋</span> 우선순위 추가</button>
        </div>
      )}
    </section>
  );
}

function PriorityPicker({ items, onClose, onConfirm }: {
  items: Development[];
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
      <form className="priority-picker" onSubmit={submit}>
        <header>
          <div><span>ADD QA PRIORITY</span><h2>우선순위 추가</h2><p>일정 대시보드에서 ‘품질진행’ 상태인 개발 건만 표시됩니다.</p></div>
          <button type="button" onClick={onClose} aria-label="팝업 닫기">×</button>
        </header>
        <div className="priority-picker-list">
          {items.length ? items.map((item) => {
            const checked = selectedIds.includes(item.id);
            return (
              <label key={item.id} className={checked ? "checked" : ""}>
                <input type="checkbox" checked={checked} onChange={() => toggle(item.id)} />
                <span className="checkmark">✓</span>
                <div><strong>{item.name}</strong><small>{item.code} · {item.customer} · {item.region}</small></div>
                <em>{item.assignees.join(" · ") || "담당자 미지정"}</em>
              </label>
            );
          }) : (
            <div className="priority-picker-empty"><span>✓</span><strong>추가 가능한 개발 건이 없습니다.</strong><small>일정 대시보드에서 개발 건의 상태를 ‘품질진행’으로 변경해주세요.</small></div>
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

function MultiFilterSelect<T extends string>({ label, allLabel, values, onChange, options }: { label: string; allLabel: string; values: T[]; onChange: (values: T[]) => void; options: readonly T[] }) {
  const toggle = (option: T) => {
    onChange(values.includes(option) ? values.filter((value) => value !== option) : [...values, option]);
  };
  const summary = values.length === 0 ? allLabel : values.length === 1 ? values[0] : `${label} ${values.length}개`;

  return (
    <details className="multi-filter">
      <summary className={values.length ? "filtered" : ""}><span>{summary}</span><i aria-hidden="true">⌄</i></summary>
      <div className="multi-filter-menu" role="group" aria-label={`${label} 필터`}>
        <label className={!values.length ? "checked" : ""}>
          <input type="checkbox" checked={!values.length} onChange={() => onChange([])} />
          <span className="multi-check">✓</span><em>{allLabel}</em>
        </label>
        <div className="multi-filter-divider" />
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

function TimelineRow({ item, month, daysCount, today, selected, onSelect }: { item: Development; month: Date; daysCount: number; today: Date; selected: boolean; onSelect: () => void }) {
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const monthEnd = new Date(month.getFullYear(), month.getMonth(), daysCount);
  const position = (phase: Phase) => {
    const rawStart = new Date(`${phase.start}T00:00:00`);
    const rawEnd = new Date(`${phase.end}T00:00:00`);
    if (rawEnd < monthStart || rawStart > monthEnd) return null;
    const visibleStart = rawStart < monthStart ? monthStart : rawStart;
    const visibleEnd = rawEnd > monthEnd ? monthEnd : rawEnd;
    const startDay = visibleStart.getDate();
    const length = Math.round((visibleEnd.getTime() - visibleStart.getTime()) / 86400000) + 1;
    return { left: `${((startDay - 1) / daysCount) * 100}%`, width: `${(length / daysCount) * 100}%` };
  };
  const progress = weightedProgress(item);
  return (
    <button className={`timeline-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="task-info">
        <div className="task-title"><strong>{item.name}</strong><small>{item.code} · {item.customer} · {item.region}</small></div>
        <div className="task-meta">
          <span className="mini-avatars">{item.assignees.slice(0, 3).map((name, index) => <i key={name} style={{ zIndex: 3 - index }} title={name}>{name.slice(0, 1)}</i>)}</span>
          <span className={`status-badge status-${item.status}`}>{item.status}</span>
          <span className="row-progress"><i style={{ width: `${progress}%` }} />{progress}%</span>
        </div>
      </div>
      <div className="timeline-track">
        <div className="day-lines">{Array.from({ length: daysCount }).map((_, index) => {
          const date = new Date(month.getFullYear(), month.getMonth(), index + 1);
          return <i key={index} className={date.getDay() === 0 || date.getDay() === 6 ? "weekend" : ""} />;
        })}</div>
        {month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth() && <span className="today-line" style={{ left: `${((today.getDate() - 0.5) / daysCount) * 100}%` }} />}
        {item.phases.map((phase) => {
          const style = position(phase);
          if (!style) return null;
          return <span key={phase.id} className={`phase-bar ${phase.type.toLowerCase()}`} style={style} title={`${phaseMeta[phase.type].label} ${phase.start} ~ ${phase.end}`}><i style={{ width: `${phase.progress}%` }} /><em>{phaseMeta[phase.type].short}</em></span>;
        })}
        {item.deploymentDate && (() => {
          const deployment = new Date(`${item.deploymentDate}T00:00:00`);
          if (deployment < monthStart || deployment > monthEnd) return null;
          return <span className="deploy-marker" style={{ left: `${((deployment.getDate() - 0.5) / daysCount) * 100}%` }} title={`배포 ${item.deploymentDate}`}>◆</span>;
        })()}
      </div>
    </button>
  );
}

function DetailPanel({ item, onClose, onStatusChange, onDelete, onMessage }: { item: Development; onClose: () => void; onStatusChange: (status: DevelopmentStatus) => void; onDelete: (item: Development) => void; onMessage: (message: string) => void }) {
  const progress = weightedProgress(item);
  return (
    <aside className="detail-panel" aria-label="개발 상세">
      <div className="detail-head">
        <div><span className="detail-code">{item.code}</span><h2>{item.name}</h2></div>
        <button onClick={onClose} aria-label="상세 닫기">×</button>
      </div>
      <div className="detail-scroll">
        <div className="detail-state-row">
          <label>진행 상태<select value={item.status} onChange={(event) => onStatusChange(event.target.value as DevelopmentStatus)}>{statusOptions.map((status) => <option key={status}>{status}</option>)}</select></label>
          <div className="overall-progress"><span>{progress}%</span><i><b style={{ width: `${progress}%` }} /></i></div>
        </div>
        <section className="detail-section">
          <h3>기본 정보</h3>
          <dl className="detail-grid">
            <div><dt>고객사</dt><dd>{item.customer}</dd></div><div><dt>지역</dt><dd>{item.region}</dd></div>
            <div className="wide"><dt>개발 구분</dt><dd>{item.category}</dd></div>
            <div className="wide"><dt>담당자</dt><dd>{item.assignees.join(" · ")}</dd></div>
            <div className="wide"><dt>배포 예정일</dt><dd>{item.deploymentDate ?? "미정"}</dd></div>
          </dl>
        </section>
        <section className="detail-section"><h3>개발 요약</h3><p className="body-copy">{item.summary}</p></section>
        <section className="detail-section"><h3>필요사항</h3><p className="requirement-copy">{item.requirements || "등록된 필요사항이 없습니다."}</p></section>
        <section className="detail-section">
          <h3>단계별 일정 <small>총 {item.phases.reduce((sum, phase) => sum + phase.md, 0)} MD</small></h3>
          <div className="phase-list">{item.phases.map((phase) => <article key={phase.id}><span className={`phase-chip ${phase.type.toLowerCase()}`}>{phaseMeta[phase.type].label}</span><div><strong>{formatShortDate(phase.start)} ~ {formatShortDate(phase.end)}</strong><small>{phase.md} MD</small></div><em>{phase.progress}%</em></article>)}</div>
        </section>
      </div>
      <div className="detail-actions"><button className="danger" onClick={() => onDelete(item)}>삭제</button><button onClick={() => onMessage("수정 폼은 개발 등록 폼과 통합 예정입니다.")}>수정</button><button className="solid" onClick={() => onMessage("상세 변경사항을 저장했습니다.")}>저장</button></div>
    </aside>
  );
}

function DevelopmentForm({ items, onClose, onSave }: { items: Development[]; onClose: () => void; onSave: (item: Development) => Promise<boolean> }) {
  const [saving, setSaving] = useState(false);
  const [scheduleConflicts, setScheduleConflicts] = useState<Development[]>([]);
  const [pendingDevelopment, setPendingDevelopment] = useState<Development | null>(null);
  const [form, setForm] = useState(() => {
    const start = localDate(new Date());
    const end = addDays(start, 11);
    return { name: "", customer: "사업팀", region: "", category: "프로젝트" as Development["category"], assignee: "담당자", summary: "", requirements: "", start, end, businessMd: 2, developmentMd: 8, qaMd: 3, deploymentDate: addDays(end, 3) };
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.region.trim()) return;
    setSaving(true);
    const id = uuidv4();
    const endDate = new Date(`${form.end}T00:00:00`);
    const startDate = new Date(`${form.start}T00:00:00`);
    const totalDays = Math.max(7, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
    const businessEnd = addDays(form.start, Math.max(1, Math.round(totalDays * 0.15)));
    const qaStart = addDays(form.end, -Math.max(2, Math.round(totalDays * 0.2)));
    const development: Development = {
      id,
      code: createCode(items),
      name: form.name.trim(), customer: form.customer.trim(), region: form.region.trim(), category: form.category,
      status: "대기중", summary: form.summary.trim(), requirements: form.requirements.trim(), assignees: form.assignee.split(",").map((name) => name.trim()).filter(Boolean), deploymentDate: form.deploymentDate,
      phases: [
        { id: uuidv4(), type: "BUSINESS", start: form.start, end: businessEnd, md: Number(form.businessMd), progress: 0 },
        { id: uuidv4(), type: "DEVELOPMENT", start: addDays(businessEnd, 1), end: addDays(qaStart, -1), md: Number(form.developmentMd), progress: 0 },
        { id: uuidv4(), type: "QA", start: qaStart, end: form.end, md: Number(form.qaMd), progress: 0 },
      ], updatedAt: new Date().toISOString(),
    };
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
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="development-form" onSubmit={submit}>
        <header><div><span>NEW DEVELOPMENT</span><h2>새 개발 건 등록</h2><p>기본정보와 단계별 일정·공수를 입력합니다.</p></div><button type="button" onClick={onClose}>×</button></header>
        <div className="form-scroll">
          <fieldset><legend>기본 정보</legend><div className="form-grid">
            <label className="wide">개발명 <input autoFocus required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="예: 부산 승하차단말기 8BIN 적용" /></label>
            <label>고객사 <input value={form.customer} onChange={(e) => set("customer", e.target.value)} /></label>
            <label>지역 <input required value={form.region} onChange={(e) => set("region", e.target.value)} placeholder="예: 부산" /></label>
            <label className="wide">개발 구분 <select value={form.category} onChange={(e) => set("category", e.target.value)}><option>프로젝트</option><option>유지보수</option></select></label>
            <label className="wide">담당자 <input value={form.assignee} onChange={(e) => set("assignee", e.target.value)} placeholder="여러 명은 쉼표로 구분" /><small>여러 명은 쉼표(,)로 구분하세요.</small></label>
            <label className="wide">개발 요약 <textarea value={form.summary} onChange={(e) => set("summary", e.target.value)} rows={3} placeholder="개발 목적과 핵심 내용을 적어주세요." /></label>
            <label className="wide">필요사항 <textarea value={form.requirements} onChange={(e) => set("requirements", e.target.value)} rows={2} placeholder="고객사 회신, 샘플 장비 등 선행 필요사항" /></label>
          </div></fieldset>
          <fieldset><legend>일정 및 공수</legend><div className="form-grid">
            <label>전체 시작일 <input type="date" value={form.start} onChange={(e) => set("start", e.target.value)} /></label>
            <label>전체 종료일 <input type="date" min={form.start} value={form.end} onChange={(e) => set("end", e.target.value)} /></label>
            <label>사업 공수 (MD) <input type="number" min="0" step="0.5" value={form.businessMd} onChange={(e) => set("businessMd", Number(e.target.value))} /></label>
            <label>개발 공수 (MD) <input type="number" min="0" step="0.5" value={form.developmentMd} onChange={(e) => set("developmentMd", Number(e.target.value))} /></label>
            <label>품질 공수 (MD) <input type="number" min="0" step="0.5" value={form.qaMd} onChange={(e) => set("qaMd", Number(e.target.value))} /></label>
            <label>배포 예정일 <input type="date" value={form.deploymentDate} onChange={(e) => set("deploymentDate", e.target.value)} /></label>
          </div></fieldset>
        </div>
        <footer><button type="button" onClick={onClose}>취소</button><button className="solid" disabled={saving}>{saving ? "저장 중..." : "개발 건 등록"}</button></footer>
      </form>
      {pendingDevelopment && scheduleConflicts.length > 0 && (
        <div className="conflict-backdrop">
          <section className="conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title">
            <header><span aria-hidden="true">!</span><div><small>SCHEDULE OVERLAP</small><h3 id="conflict-title">중복 일정 {scheduleConflicts.length}건이 있습니다.</h3></div></header>
            <p><strong>{pendingDevelopment.name}</strong>의 일정과 아래 개발업무가 겹칩니다.</p>
            <div className="conflict-list">
              {scheduleConflicts.map((item) => (
                <article key={item.id}>
                  <div><strong>{item.name}</strong><small>{item.code} · {item.status}</small></div>
                  <span>{dateRange(item)}</span>
                </article>
              ))}
            </div>
            <footer>
              <button type="button" onClick={() => { setPendingDevelopment(null); setScheduleConflicts([]); }}>일정 다시 확인</button>
              <button type="button" className="solid warning" disabled={saving} onClick={saveWithConflicts}>{saving ? "등록 중..." : "그래도 등록"}</button>
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
  return <main className="login-page"><section className="login-brand"><span className="brand-mark large">M</span><p>MYBI INFRA</p><h1>개발의 흐름을<br />한눈에 관리하세요.</h1><small>사업 · 개발 · 품질 일정을 하나의 화면에서 공유합니다.</small></section><form className="login-card" onSubmit={submit}><span>INTERNAL WORKSPACE</span><h2>로그인</h2><p>관리자가 등록한 계정으로 접속해주세요.</p><label>이메일<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></label><label>비밀번호<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="비밀번호 입력" /></label>{error && <em>{error}</em>}<button disabled={submitting}>{submitting ? "확인 중..." : "로그인"}</button></form></main>;
}
