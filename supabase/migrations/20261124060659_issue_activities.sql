-- Standalone issues are supported on installations upgraded from the original issues migration.
alter table public.issues alter column development_id drop not null;

create table if not exists public.issue_activities (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  activity_date date not null,
  content text not null check (length(btrim(content)) > 0),
  created_at timestamptz not null default now()
);
create index if not exists issue_activities_issue_time_idx
  on public.issue_activities(issue_id, created_at, id);

alter table public.issue_activities enable row level security;
revoke all on public.issue_activities from public, anon, authenticated;
grant select, insert on public.issue_activities to authenticated;

drop policy if exists "read activities of visible issues" on public.issue_activities;
create policy "read activities of visible issues" on public.issue_activities
  for select to authenticated using (exists (
    select 1 from public.issues i where i.id = issue_id
  ));
drop policy if exists "append activities to visible issues" on public.issue_activities;
create policy "append activities to visible issues" on public.issue_activities
  for insert to authenticated with check (exists (
    select 1 from public.issues i where i.id = issue_id
  ));
