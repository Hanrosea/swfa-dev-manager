-- 기존 Supabase 프로젝트에 개발업무별 이슈사항 관리를 추가합니다.
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

create index if not exists issues_development_id_idx
  on public.issues(development_id);

drop trigger if exists issues_touch_updated_at on public.issues;
create trigger issues_touch_updated_at before update on public.issues
for each row execute function public.touch_updated_at();

alter table public.issues enable row level security;

drop policy if exists "authenticated users manage issues" on public.issues;
create policy "authenticated users manage issues"
  on public.issues for all to authenticated using (true) with check (true);
