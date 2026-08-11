-- Supabase SQL Editor에서 전체 실행하세요.
create extension if not exists "pgcrypto";

create table if not exists public.developments (
  id uuid primary key default gen_random_uuid(),
  development_code text not null unique,
  name text not null,
  customer text,
  region text,
  category text not null check (category in ('프로젝트', '유지보수')),
  status text not null default '대기중' check (status in ('대기중', '개발진행', '품질진행', '완료')),
  summary text,
  requirements text,
  assignee_names text[] not null default '{}',
  deployment_date date,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.development_phases (
  id uuid primary key default gen_random_uuid(),
  development_id uuid not null references public.developments(id) on delete cascade,
  phase_type text not null check (phase_type in ('BUSINESS', 'DEVELOPMENT', 'QA', 'DEPLOY')),
  planned_start date not null,
  planned_end date not null,
  actual_start date,
  actual_end date,
  planned_md numeric(7,2) not null default 0,
  actual_md numeric(7,2),
  progress integer not null default 0 check (progress between 0 and 100),
  status text not null default '대기' check (status in ('대기', '진행중', '완료', '지연', '제외')),
  memo text,
  created_at timestamptz not null default now()
);

create table if not exists public.qa_priorities (
  development_id uuid primary key references public.developments(id) on delete cascade,
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  development_id uuid not null references public.developments(id) on delete cascade,
  title text not null,
  content text,
  severity text not null default '보통' check (severity in ('긴급', '높음', '보통', '낮음')),
  status text not null default '등록' check (status in ('등록', '처리중', '해결', '보류')),
  assignee_id uuid references auth.users(id),
  due_date date,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  development_id uuid not null references public.developments(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.activity_logs (
  id bigint generated always as identity primary key,
  development_id uuid references public.developments(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  changed_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists developments_status_idx on public.developments(status);
create index if not exists developments_region_idx on public.developments(region);
create index if not exists development_phases_development_id_idx on public.development_phases(development_id);
create unique index if not exists qa_priorities_sort_order_idx on public.qa_priorities(sort_order);
create index if not exists issues_development_id_idx on public.issues(development_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists developments_touch_updated_at on public.developments;
create trigger developments_touch_updated_at before update on public.developments
for each row execute function public.touch_updated_at();

drop trigger if exists qa_priorities_touch_updated_at on public.qa_priorities;
create trigger qa_priorities_touch_updated_at before update on public.qa_priorities
for each row execute function public.touch_updated_at();

drop trigger if exists issues_touch_updated_at on public.issues;
create trigger issues_touch_updated_at before update on public.issues
for each row execute function public.touch_updated_at();

alter table public.developments enable row level security;
alter table public.development_phases enable row level security;
alter table public.qa_priorities enable row level security;
alter table public.issues enable row level security;
alter table public.comments enable row level security;
alter table public.activity_logs enable row level security;

create policy "authenticated users read developments" on public.developments for select to authenticated using (true);
create policy "authenticated users insert developments" on public.developments for insert to authenticated with check (true);
create policy "authenticated users update developments" on public.developments for update to authenticated using (true) with check (true);

create policy "authenticated users read phases" on public.development_phases for select to authenticated using (true);
create policy "authenticated users insert phases" on public.development_phases for insert to authenticated with check (true);
create policy "authenticated users update phases" on public.development_phases for update to authenticated using (true) with check (true);
create policy "authenticated users delete phases" on public.development_phases for delete to authenticated using (true);

create policy "authenticated users read qa priorities" on public.qa_priorities for select to authenticated using (true);
create policy "authenticated users insert qa priorities" on public.qa_priorities for insert to authenticated with check (true);
create policy "authenticated users update qa priorities" on public.qa_priorities for update to authenticated using (true) with check (true);
create policy "authenticated users delete qa priorities" on public.qa_priorities for delete to authenticated using (true);

create policy "authenticated users manage issues" on public.issues for all to authenticated using (true) with check (true);
create policy "authenticated users manage comments" on public.comments for all to authenticated using (true) with check (author_id = auth.uid());
create policy "authenticated users read logs" on public.activity_logs for select to authenticated using (true);
create policy "authenticated users add logs" on public.activity_logs for insert to authenticated with check (actor_id = auth.uid());
