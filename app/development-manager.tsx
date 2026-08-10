"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { initialDevelopments } from "@/lib/mock-data";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  Development,
  DevelopmentStatus,
  Phase,
  PhaseType,
} from "@/lib/types";

const STORAGE_KEY = "mybi-infra-dev-manager-v1";
const statusOptions: DevelopmentStatus[] = [
  "요청",
  "검토중",
  "일정수립",
  "개발대기",
  "개발중",
  "품질검증",
  "배포대기",
  "완료",
  "보류",
];

const phaseMeta: Record<PhaseType, { label: string; short: string }> = {
  BUSINESS: { label: "사업", short: "사" },
  DEVELOPMENT: { label: "개발", short: "개" },
  QA: { label: "품질", short: "품" },
  DEPLOY: { label: "배포", short: "배" },
};

const menuItems = ["일정 대시보드", "전체 개발", "이슈 관리", "보고서"];

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

function createCode(items: Development[]) {
  const max = items.reduce((value, item) => {
    const number = Number(item.code.split("-").at(-1));
    return Number.isNaN(number) ? value : Math.max(value, number);
  }, 0);
  return `DEV-2026-${String(max + 1).padStart(4, "0")}`;
}

function mapDatabaseRow(row: Record<string, unknown>): Development {
  const phases = (row.development_phases as Record<string, unknown>[] | null) ?? [];
  const issues = (row.issues as Record<string, unknown>[] | null) ?? [];
  return {
    id: String(row.id),
    code: String(row.development_code),
    name: String(row.name),
    customer: String(row.customer ?? ""),
    region: String(row.region ?? ""),
    category: row.category as Development["category"],
    priority: row.priority as Development["priority"],
    status: row.status as DevelopmentStatus,
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
    issues: issues.map((issue) => ({
      id: String(issue.id),
      title: String(issue.title),
      status: issue.status as Development["issues"][number]["status"],
      severity: issue.severity as Development["issues"][number]["severity"],
      dueDate: issue.due_date ? String(issue.due_date) : undefined,
    })),
  };
}

export default function DevelopmentManager() {
  const [items, setItems] = useState<Development[]>(initialDevelopments);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [month, setMonth] = useState(() => new Date(2026, 7, 1));
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("전체 상태");
  const [categoryFilter, setCategoryFilter] = useState("전체 구분");
  const [assigneeFilter, setAssigneeFilter] = useState("전체 담당자");
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as Development[];
          queueMicrotask(() => setItems(parsed));
        } catch {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      }
      return;
    }

    let mounted = true;
    const load = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!mounted) return;
      setUserEmail(sessionData.session?.user.email ?? null);
      if (sessionData.session) {
        const { data, error } = await supabase
          .from("developments")
          .select("*, development_phases(*), issues(*)")
          .is("deleted_at", null)
          .order("updated_at", { ascending: false });
        if (!error) setItems((data ?? []).map(mapDatabaseRow));
      }
      setLoading(false);
    };
    load();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user.email ?? null);
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
        (statusFilter === "전체 상태" || item.status === statusFilter) &&
        (categoryFilter === "전체 구분" || item.category === categoryFilter) &&
        (assigneeFilter === "전체 담당자" || item.assignees.includes(assigneeFilter))
      );
    });
  }, [items, query, statusFilter, categoryFilter, assigneeFilter]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const daysCount = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: daysCount }, (_, index) => index + 1);
  const today = new Date(2026, 7, 10);
  const isCurrentMonth =
    month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();
  const openIssues = items.reduce(
    (count, item) => count + item.issues.filter((issue) => issue.status !== "해결").length,
    0,
  );
  const activeCount = items.filter((item) => !["완료", "보류"].includes(item.status)).length;
  const delayedCount = items.filter((item) => {
    const end = item.phases.map((phase) => phase.end).sort().at(-1);
    return end && end < localDate(today) && weightedProgress(item) < 100;
  }).length;

  const changeMonth = (offset: number) => {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  };

  const showMessage = (message: string) => setToast(message);

  const saveDevelopment = async (development: Development) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setItems((current) => {
        const exists = current.some((item) => item.id === development.id);
        return exists
          ? current.map((item) => (item.id === development.id ? development : item))
          : [development, ...current];
      });
      setSelectedId(development.id);
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
      priority: development.priority,
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
    showMessage("DB에 저장했습니다.");
    return true;
  };

  const quickStatusChange = async (status: DevelopmentStatus) => {
    if (!selected) return;
    await saveDevelopment({ ...selected, status, updatedAt: new Date().toISOString() });
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
          {menuItems.map((item, index) => (
            <button className={index === 0 ? "active" : ""} key={item} onClick={() => index !== 0 && showMessage("2차 개발 범위에 포함된 메뉴입니다.")}>
              <span className="nav-icon" aria-hidden="true">{["▦", "≡", "!", "▥"][index]}</span>
              {item}
              {item === "이슈 관리" && <em>{openIssues}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="user-card">
            <span className="avatar">{(userEmail ?? "조준우").slice(0, 1).toUpperCase()}</span>
            <div><strong>{userEmail ? userEmail.split("@")[0] : "조준우"}</strong><small>PM / 매니저</small></div>
          </div>
          <button className="settings-button" onClick={() => showMessage("관리자 설정은 다음 단계에서 연결합니다.")}>⚙</button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">차량내디바이스팀</p>
            <h1>개발 일정 대시보드</h1>
          </div>
          <div className="top-actions">
            <span className={`mode-pill ${isSupabaseConfigured ? "db" : "demo"}`}>
              <i /> {isSupabaseConfigured ? "DB 연결" : "데모 모드"}
            </span>
            <button className="icon-button" aria-label="알림" onClick={() => showMessage("새 알림이 없습니다.")}>♢</button>
            <button className="primary-button" onClick={() => setShowForm(true)}><span>＋</span> 개발 등록</button>
          </div>
        </header>

        <section className="stat-grid" aria-label="일정 요약">
          <StatCard label="전체 개발" value={items.length} helper="등록된 개발 건" tone="navy" icon="▦" />
          <StatCard label="진행 중" value={activeCount} helper="이번 달 작업" tone="blue" icon="▶" />
          <StatCard label="열린 이슈" value={openIssues} helper="확인 필요" tone="orange" icon="!" />
          <StatCard label="지연" value={delayedCount} helper={delayedCount ? "조치 필요" : "정상 진행"} tone="red" icon="↗" />
        </section>

        <section className="schedule-card">
          <div className="schedule-toolbar">
            <div className="month-control">
              <button onClick={() => changeMonth(-1)} aria-label="이전 달">‹</button>
              <strong>{month.getFullYear()}년 {month.getMonth() + 1}월</strong>
              <button onClick={() => changeMonth(1)} aria-label="다음 달">›</button>
              <button className="today-button" onClick={() => setMonth(new Date(2026, 7, 1))}>오늘</button>
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
            <FilterSelect value={statusFilter} onChange={setStatusFilter} options={["전체 상태", ...statusOptions]} />
            <FilterSelect value={categoryFilter} onChange={setCategoryFilter} options={["전체 구분", "프로젝트", "유지보수", "공통수정", "내부개선"]} />
            <FilterSelect value={assigneeFilter} onChange={setAssigneeFilter} options={["전체 담당자", ...assignees]} />
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
      </section>

      {selected && (
        <DetailPanel item={selected} onClose={() => setSelectedId(null)} onStatusChange={quickStatusChange} onMessage={showMessage} />
      )}
      {showForm && <DevelopmentForm items={items} onClose={() => setShowForm(false)} onSave={saveDevelopment} />}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}

function StatCard({ label, value, helper, tone, icon }: { label: string; value: number; helper: string; tone: string; icon: string }) {
  return <article className={`stat-card ${tone}`}><span className="stat-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong><small>{helper}</small></div></article>;
}

function FilterSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: string[] }) {
  return <label className="filter-select"><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>;
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
  const issueCount = item.issues.filter((issue) => issue.status !== "해결").length;
  return (
    <button className={`timeline-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="task-info">
        <span className={`priority-dot ${item.priority}`} />
        <div className="task-title"><strong>{item.name}</strong><small>{item.code} · {item.customer} · {item.region}</small></div>
        <div className="task-meta">
          <span className="mini-avatars">{item.assignees.slice(0, 3).map((name, index) => <i key={name} style={{ zIndex: 3 - index }} title={name}>{name.slice(0, 1)}</i>)}</span>
          <span className={`status-badge status-${item.status}`}>{item.status}</span>
          <span className="row-progress"><i style={{ width: `${progress}%` }} />{progress}%</span>
          {issueCount > 0 && <span className="issue-count">! {issueCount}</span>}
        </div>
      </div>
      <div className="timeline-track">
        <div className="day-lines">{Array.from({ length: daysCount }).map((_, index) => {
          const date = new Date(month.getFullYear(), month.getMonth(), index + 1);
          return <i key={index} className={date.getDay() === 0 || date.getDay() === 6 ? "weekend" : ""} />;
        })}</div>
        {month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth() && <span className="today-line" style={{ left: `${((today.getDate() - 0.5) / daysCount) * 100}%` }} />}
        {item.phases.map((phase, index) => {
          const style = position(phase);
          if (!style) return null;
          return <span key={phase.id} className={`phase-bar ${phase.type.toLowerCase()}`} style={{ ...style, top: `${13 + index * 13}px` }} title={`${phaseMeta[phase.type].label} ${phase.start} ~ ${phase.end}`}><i style={{ width: `${phase.progress}%` }} /><em>{phaseMeta[phase.type].short}</em></span>;
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

function DetailPanel({ item, onClose, onStatusChange, onMessage }: { item: Development; onClose: () => void; onStatusChange: (status: DevelopmentStatus) => void; onMessage: (message: string) => void }) {
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
            <div><dt>개발 구분</dt><dd>{item.category}</dd></div><div><dt>우선순위</dt><dd><span className={`priority-text ${item.priority}`}>{item.priority}</span></dd></div>
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
        <section className="detail-section">
          <h3>이슈 <small>{item.issues.length}건</small></h3>
          <div className="issue-list">{item.issues.length ? item.issues.map((issue) => <article key={issue.id}><span className={`severity ${issue.severity}`}>!</span><div><strong>{issue.title}</strong><small>{issue.status}{issue.dueDate ? ` · ${formatShortDate(issue.dueDate)}까지` : ""}</small></div></article>) : <p className="no-issue">등록된 이슈가 없습니다.</p>}</div>
          <button className="text-button" onClick={() => onMessage("이슈 등록 화면은 다음 단계에서 연결합니다.")}>＋ 이슈 추가</button>
        </section>
      </div>
      <div className="detail-actions"><button onClick={() => onMessage("수정 폼은 개발 등록 폼과 통합 예정입니다.")}>수정</button><button className="solid" onClick={() => onMessage("상세 변경사항을 저장했습니다.")}>저장</button></div>
    </aside>
  );
}

function DevelopmentForm({ items, onClose, onSave }: { items: Development[]; onClose: () => void; onSave: (item: Development) => Promise<boolean> }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", customer: "마이비인프라", region: "", category: "프로젝트" as Development["category"], priority: "보통" as Development["priority"], assignee: "조준우", summary: "", requirements: "", start: "2026-08-17", end: "2026-08-28", businessMd: 2, developmentMd: 8, qaMd: 3, deploymentDate: "2026-08-31" });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.region.trim()) return;
    setSaving(true);
    const id = crypto.randomUUID();
    const endDate = new Date(`${form.end}T00:00:00`);
    const startDate = new Date(`${form.start}T00:00:00`);
    const totalDays = Math.max(7, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
    const businessEnd = addDays(form.start, Math.max(1, Math.round(totalDays * 0.15)));
    const qaStart = addDays(form.end, -Math.max(2, Math.round(totalDays * 0.2)));
    const development: Development = {
      id,
      code: createCode(items),
      name: form.name.trim(), customer: form.customer.trim(), region: form.region.trim(), category: form.category, priority: form.priority,
      status: "일정수립", summary: form.summary.trim(), requirements: form.requirements.trim(), assignees: form.assignee.split(",").map((name) => name.trim()).filter(Boolean), deploymentDate: form.deploymentDate,
      phases: [
        { id: crypto.randomUUID(), type: "BUSINESS", start: form.start, end: businessEnd, md: Number(form.businessMd), progress: 0 },
        { id: crypto.randomUUID(), type: "DEVELOPMENT", start: addDays(businessEnd, 1), end: addDays(qaStart, -1), md: Number(form.developmentMd), progress: 0 },
        { id: crypto.randomUUID(), type: "QA", start: qaStart, end: form.end, md: Number(form.qaMd), progress: 0 },
      ], issues: [], updatedAt: new Date().toISOString(),
    };
    if (await onSave(development)) onClose();
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
            <label>개발 구분 <select value={form.category} onChange={(e) => set("category", e.target.value)}><option>프로젝트</option><option>유지보수</option><option>공통수정</option><option>내부개선</option></select></label>
            <label>우선순위 <select value={form.priority} onChange={(e) => set("priority", e.target.value)}><option>긴급</option><option>높음</option><option>보통</option><option>낮음</option></select></label>
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
