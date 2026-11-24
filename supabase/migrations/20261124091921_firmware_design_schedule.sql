select pg_advisory_xact_lock(61124, 1);

alter table public.development_firmware
  add column design_start date,
  add column design_end date,
  add constraint firmware_design_dates check (
    (design_start is null) = (design_end is null) and design_start <= design_end
  );

-- Keep the superseded manual date for projects updated by this migration.
alter table public.developments add column legacy_deployment_date date;

create function public.deployment_after_qa(quality_end date)
returns date language sql immutable strict security invoker set search_path = '' as $$
  select quality_end + case extract(isodow from quality_end) when 5 then 3 when 6 then 2 else 1 end;
$$;
revoke all on function public.deployment_after_qa(date) from public, anon;
grant execute on function public.deployment_after_qa(date) to authenticated;

with derived as (
  select d.id, public.deployment_after_qa(max(f.qa_end)) as next_release
  from public.developments d left join public.development_firmware f on f.development_id = d.id
  where d.deleted_at is null
  group by d.id
)
update public.developments d
set legacy_deployment_date = d.deployment_date, deployment_date = derived.next_release
from derived where d.id = derived.id and d.deployment_date is distinct from derived.next_release;

create or replace function public.save_development_fw(project jsonb, expected_updated_at timestamptz)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare
  project_id uuid := (project->>'id')::uuid;
  current_project public.developments%rowtype;
  saved_at timestamptz;
  next_deployment date;
  effort_key text;
  requirement_rows jsonb;
  requirement_text text;
begin
  -- Serialize rank changes with edits that can remove ranked FW.
  perform pg_advisory_xact_lock(61124, 1);
  select * into current_project from public.developments where id = project_id for update;
  if current_project.deleted_at is not null or current_project.updated_at is distinct from expected_updated_at then
    raise exception '다른 사용자가 변경한 개발 건입니다. 새로고침 후 다시 수정해주세요.';
  end if;
  if jsonb_typeof(project->'firmware') is distinct from 'array' then raise exception '개발 FW 목록을 확인해주세요.'; end if;
  select public.deployment_after_qa(max(nullif(f->>'qaEnd', '')::date)) into next_deployment
  from jsonb_array_elements(project->'firmware') f;
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

  if jsonb_typeof(project->'requirements') = 'array' then
    requirement_rows := project->'requirements';
    select coalesce(string_agg(r->>'detail', E'\n' order by n), '') into requirement_text
      from jsonb_array_elements(requirement_rows) with ordinality as rows(r,n);
  elsif not (project ? 'requirements') then
    requirement_text := current_project.requirements;
  elsif jsonb_typeof(project->'requirements') in ('string', 'null') then
    -- Older clients still submit a single text field. Unchanged text leaves structured rows intact.
    requirement_text := coalesce(project->>'requirements', '');
    if requirement_text is distinct from coalesce(current_project.requirements, '') then
      if exists (select 1 from public.development_requirements r where r.development_id = project_id
        and (r.id <> project_id or r.kind <> '' or r.reason <> '' or r.scheduled_on is not null or r.status is not null)) then
        raise exception '필요사항이 표 형식으로 변경되었습니다. 새로고침 후 수정해주세요.';
      end if;
      requirement_rows := case when btrim(requirement_text) = '' then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object('id', project_id, 'detail', requirement_text)) end;
    end if;
  else
    raise exception '필요사항 목록을 확인해주세요.';
  end if;

  insert into public.developments(id, development_code, name, customer, region, category, status, summary, requirements, assignee_names, deployment_date, effort_md)
  values (project_id, project->>'code', project->>'name', project->>'customer', project->>'region',
    project->>'category', project->>'status', project->>'summary', requirement_text,
    array(select jsonb_array_elements_text(project->'assignees')), next_deployment, project->'effort')
  on conflict (id) do update set
    name = excluded.name, customer = excluded.customer, region = excluded.region, category = excluded.category,
    status = excluded.status, summary = excluded.summary, requirements = excluded.requirements,
    assignee_names = excluded.assignee_names, deployment_date = excluded.deployment_date, effort_md = excluded.effort_md
  returning updated_at into saved_at;

  delete from public.development_firmware fw where fw.development_id = project_id
    and not exists (select 1 from jsonb_array_elements(project->'firmware') f where (f->>'id')::uuid = fw.id);
  insert into public.development_firmware as fw (id, development_id, row_no, region, kind, version, design_start, design_end, dev_start, dev_end, qa_start, qa_end, status)
  select (f->>'id')::uuid, project_id, n, f->>'region', f->>'kind', f->>'version',
    -- A form opened on an older version has no design fields. An explicit empty pair clears the dates.
    case when f ? 'designStart' then nullif(f->>'designStart','')::date else prior.design_start end,
    case when f ? 'designEnd' then nullif(f->>'designEnd','')::date else prior.design_end end,
    nullif(f->>'devStart','')::date,
    nullif(f->>'devEnd','')::date, nullif(f->>'qaStart','')::date, nullif(f->>'qaEnd','')::date, f->>'status'
  from jsonb_array_elements(project->'firmware') with ordinality as rows(f,n)
  left join public.development_firmware prior on prior.id = (f->>'id')::uuid and prior.development_id = project_id
  on conflict (id) do update set
    row_no = excluded.row_no, region = excluded.region, kind = excluded.kind, version = excluded.version,
    design_start = excluded.design_start, design_end = excluded.design_end,
    dev_start = excluded.dev_start, dev_end = excluded.dev_end, qa_start = excluded.qa_start, qa_end = excluded.qa_end,
    status = excluded.status, qa_order = case when excluded.status = '품질진행' then fw.qa_order end;
  if requirement_rows is not null then
    delete from public.development_requirements r where r.development_id = project_id;
    insert into public.development_requirements (development_id, id, row_no, kind, detail, reason, scheduled_on, status)
    select project_id, (r->>'id')::uuid, n, coalesce(r->>'kind', ''), coalesce(r->>'detail', ''),
      coalesce(r->>'reason', ''), nullif(r->>'scheduledOn', '')::date, nullif(r->>'status', '')
    from jsonb_array_elements(requirement_rows) with ordinality as rows(r,n);
  end if;
  return saved_at;
end;
$$;

notify pgrst, 'reload schema';
