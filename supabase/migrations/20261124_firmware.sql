-- Apply once to the existing schema before releasing the FW editor.
begin;

alter table public.developments add column if not exists effort_md jsonb;
create table if not exists public.development_firmware (
  id uuid primary key,
  development_id uuid not null references public.developments(id) on delete cascade,
  row_no integer not null check (row_no > 0),
  region text not null default '',
  kind text not null default '' check (kind in ('', '운전자', '승하차', '운영정보')),
  version text not null default '',
  dev_start date, dev_end date, qa_start date, qa_end date,
  status text not null check (status in ('대기중', '개발진행', '품질진행', '완료')),
  qa_order integer unique check (qa_order is null or (qa_order >= 0 and status = '품질진행')),
  check ((dev_start is null) = (dev_end is null) and dev_start <= dev_end),
  check ((qa_start is null) = (qa_end is null) and qa_start <= qa_end)
);
create index if not exists development_firmware_parent_idx on public.development_firmware(development_id, row_no);

-- A legacy project ID also identifies its first FW so existing QA ranks keep their identity.
insert into public.development_firmware (id, development_id, row_no, region, status, dev_start, dev_end, qa_start, qa_end, qa_order)
select d.id, d.id, 1, coalesce(d.region, ''), d.status,
  min(p.planned_start) filter (where p.phase_type = 'DEVELOPMENT'),
  max(p.planned_end) filter (where p.phase_type = 'DEVELOPMENT'),
  min(p.planned_start) filter (where p.phase_type = 'QA'),
  max(p.planned_end) filter (where p.phase_type = 'QA'),
  case when d.status = '품질진행' and d.deleted_at is null then q.sort_order end
from public.developments d
left join public.development_phases p on p.development_id = d.id
left join public.qa_priorities q on q.development_id = d.id
where d.effort_md is null
group by d.id, q.sort_order;

update public.developments d set effort_md = (
  select jsonb_build_object(
    'management', coalesce(sum(planned_md) filter (where phase_type = 'BUSINESS'), 0),
    'design', 0,
    'development', coalesce(sum(planned_md) filter (where phase_type = 'DEVELOPMENT'), 0),
    'quality', coalesce(sum(planned_md) filter (where phase_type = 'QA'), 0),
    'execution', coalesce(sum(planned_md) filter (where phase_type = 'DEPLOY'), 0))
  from public.development_phases where development_id = d.id
) where d.effort_md is null;
alter table public.developments alter column effort_md set default '{"management":0,"design":0,"development":0,"quality":0,"execution":0}';
alter table public.developments alter column effort_md set not null;

alter table public.development_firmware enable row level security;
drop policy if exists "authenticated users manage firmware" on public.development_firmware;
create policy "authenticated users manage firmware" on public.development_firmware for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.development_firmware to authenticated;

create or replace function public.save_development_fw(project jsonb, expected_updated_at timestamptz)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare
  project_id uuid := (project->>'id')::uuid;
  current_project public.developments%rowtype;
  saved_at timestamptz;
  effort_key text;
begin
  -- Serialize rank changes with edits that can remove ranked FW.
  perform pg_advisory_xact_lock(61124, 1);
  select * into current_project from public.developments where id = project_id for update;
  if current_project.deleted_at is not null or current_project.updated_at is distinct from expected_updated_at then
    raise exception '다른 사용자가 변경한 개발 건입니다. 새로고침 후 다시 수정해주세요.';
  end if;
  if jsonb_typeof(project->'firmware') is distinct from 'array' then raise exception '개발 FW 목록을 확인해주세요.'; end if;
  foreach effort_key in array array['management','design','development','quality','execution'] loop
    if jsonb_typeof(project->'effort'->effort_key) is distinct from 'number' or (project->'effort'->>effort_key)::numeric < 0 then
      raise exception '공수에는 0 이상의 숫자를 입력해주세요.';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(project->'firmware') f
    join public.development_firmware existing on existing.id = (f->>'id')::uuid
    where existing.development_id <> project_id
  ) then raise exception '다른 프로젝트의 FW입니다.'; end if;

  insert into public.developments(id, development_code, name, customer, region, category, status, summary, requirements, assignee_names, deployment_date, effort_md)
  values (project_id, project->>'code', project->>'name', project->>'customer', project->>'region',
    project->>'category', project->>'status', project->>'summary', project->>'requirements',
    array(select jsonb_array_elements_text(project->'assignees')), nullif(project->>'deploymentDate','')::date, project->'effort')
  on conflict (id) do update set
    name = excluded.name, customer = excluded.customer, region = excluded.region, category = excluded.category,
    status = excluded.status, summary = excluded.summary, requirements = excluded.requirements,
    assignee_names = excluded.assignee_names, deployment_date = excluded.deployment_date, effort_md = excluded.effort_md
  returning updated_at into saved_at;

  delete from public.development_firmware fw where fw.development_id = project_id
    and not exists (select 1 from jsonb_array_elements(project->'firmware') f where (f->>'id')::uuid = fw.id);
  insert into public.development_firmware as fw (id, development_id, row_no, region, kind, version, dev_start, dev_end, qa_start, qa_end, status)
  select (f->>'id')::uuid, project_id, n, f->>'region', f->>'kind', f->>'version', nullif(f->>'devStart','')::date,
    nullif(f->>'devEnd','')::date, nullif(f->>'qaStart','')::date, nullif(f->>'qaEnd','')::date, f->>'status'
  from jsonb_array_elements(project->'firmware') with ordinality as rows(f,n)
  on conflict (id) do update set
    row_no = excluded.row_no, region = excluded.region, kind = excluded.kind, version = excluded.version,
    dev_start = excluded.dev_start, dev_end = excluded.dev_end, qa_start = excluded.qa_start, qa_end = excluded.qa_end,
    status = excluded.status, qa_order = case when excluded.status = '품질진행' then fw.qa_order end;
  return saved_at;
end;
$$;

create or replace function public.save_fw_priorities(expected_ids uuid[], ordered_ids uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
declare current_ids uuid[];
begin
  perform pg_advisory_xact_lock(61124, 1);
  select coalesce(array_agg(id order by qa_order), '{}'::uuid[]) into current_ids
    from public.development_firmware where qa_order is not null;
  if current_ids is distinct from expected_ids then
    raise exception '우선순위가 변경되었습니다. 새로고침 후 다시 시도해주세요.';
  end if;
  if ordered_ids is null or cardinality(ordered_ids) <> (
    select count(*) from public.development_firmware fw join public.developments d on d.id = fw.development_id
    where fw.id = any(ordered_ids) and fw.status = '품질진행' and d.deleted_at is null
  ) then raise exception '품질진행 FW만 한 번씩 등록할 수 있습니다.'; end if;
  update public.development_firmware set qa_order = null where qa_order is not null;
  update public.development_firmware fw set qa_order = list.n - 1
    from unnest(ordered_ids) with ordinality as list(id,n) where fw.id = list.id;
end;
$$;

create or replace function public.clear_deleted_fw_priorities()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(61124, 1);
  update public.development_firmware set qa_order = null where development_id = new.id and qa_order is not null;
  return new;
end;
$$;
drop trigger if exists developments_clear_fw_priority on public.developments;
create trigger developments_clear_fw_priority after update of deleted_at on public.developments
for each row when (old.deleted_at is null and new.deleted_at is not null)
execute function public.clear_deleted_fw_priorities();

revoke all on function public.save_development_fw(jsonb,timestamptz), public.save_fw_priorities(uuid[],uuid[]) from public, anon;
grant execute on function public.save_development_fw(jsonb,timestamptz), public.save_fw_priorities(uuid[],uuid[]) to authenticated;
notify pgrst, 'reload schema';
commit;
