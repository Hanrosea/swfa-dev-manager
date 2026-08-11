-- 기존 Supabase 프로젝트에 v0.4 상태 체계와 품질 우선순위를 추가하는 마이그레이션입니다.
alter table public.developments drop constraint if exists developments_status_check;

update public.developments
set status = case
  when status in ('진행중', '개발중') then '개발진행'
  when status in ('품질검증', '배포대기') then '품질진행'
  when status in ('대기중', '개발진행', '품질진행', '완료') then status
  else '대기중'
end;

alter table public.developments alter column status set default '대기중';
alter table public.developments
  add constraint developments_status_check
  check (status in ('대기중', '개발진행', '품질진행', '완료'));

create table if not exists public.qa_priorities (
  development_id uuid primary key references public.developments(id) on delete cascade,
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists qa_priorities_sort_order_idx
  on public.qa_priorities(sort_order);

drop trigger if exists qa_priorities_touch_updated_at on public.qa_priorities;
create trigger qa_priorities_touch_updated_at before update on public.qa_priorities
for each row execute function public.touch_updated_at();

alter table public.qa_priorities enable row level security;

drop policy if exists "authenticated users read qa priorities" on public.qa_priorities;
drop policy if exists "authenticated users insert qa priorities" on public.qa_priorities;
drop policy if exists "authenticated users update qa priorities" on public.qa_priorities;
drop policy if exists "authenticated users delete qa priorities" on public.qa_priorities;

create policy "authenticated users read qa priorities"
  on public.qa_priorities for select to authenticated using (true);
create policy "authenticated users insert qa priorities"
  on public.qa_priorities for insert to authenticated with check (true);
create policy "authenticated users update qa priorities"
  on public.qa_priorities for update to authenticated using (true) with check (true);
create policy "authenticated users delete qa priorities"
  on public.qa_priorities for delete to authenticated using (true);
