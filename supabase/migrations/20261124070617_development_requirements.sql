select pg_advisory_xact_lock(61124, 1);

-- A stable row ID keeps a requirement identifiable when its display number changes.
create table if not exists public.development_requirements (
  development_id uuid not null references public.developments(id) on delete cascade,
  id uuid not null,
  row_no integer not null check (row_no > 0),
  kind text not null default '',
  detail text not null default '',
  reason text not null default '',
  scheduled_on date,
  status text check (status in ('자료요청', '회신대기', '수신완료')),
  primary key (development_id, id),
  unique (development_id, row_no)
);

alter table public.development_requirements enable row level security;
revoke all on public.development_requirements from public, anon, authenticated;
grant select, insert, update, delete on public.development_requirements to authenticated;
drop policy if exists "team manages visible project requirements" on public.development_requirements;
create policy "team manages visible project requirements"
  on public.development_requirements for all to authenticated
  using (exists (select 1 from public.developments d where d.id = development_id and d.deleted_at is null))
  with check (exists (select 1 from public.developments d where d.id = development_id and d.deleted_at is null));

-- Retain the entire original note including line breaks. A note does not imply a status.
insert into public.development_requirements (development_id, id, row_no, detail)
select d.id, d.id, 1, d.requirements from public.developments d
where nullif(btrim(d.requirements), '') is not null and not exists (
  select 1 from public.development_requirements r where r.development_id = d.id
);

create or replace function public.save_development_fw(project jsonb, expected_updated_at timestamptz)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare
  project_id uuid := (project->>'id')::uuid;
  current_project public.developments%rowtype;
  saved_at timestamptz;
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

-- A status edit changes a single row and invalidates stale full-project forms.
create or replace function public.set_development_row_status(
  target_project uuid, row_type text, target_row uuid, expected_status text, next_status text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  saved public.developments%rowtype;
begin
  perform pg_advisory_xact_lock(61124, 1);
  perform 1 from public.developments where id = target_project and deleted_at is null for update;
  if not found then raise exception '프로젝트를 찾을 수 없습니다.' using errcode = '40001'; end if;

  if row_type = 'requirement' and next_status in ('자료요청', '회신대기', '수신완료') then
    update public.development_requirements set status = next_status
    where development_id = target_project and id = target_row and status is not distinct from expected_status;
  elsif row_type = 'firmware' and next_status in ('대기중', '개발진행', '품질진행', '완료') then
    update public.development_firmware set status = next_status,
      qa_order = case when next_status = '품질진행' then qa_order end
    where development_id = target_project and id = target_row and status = expected_status;
  else
    raise exception '선택한 진행사항을 확인해주세요.';
  end if;
  if not found then raise exception '다른 사용자가 행을 수정하거나 삭제했습니다.' using errcode = '40001'; end if;

  update public.developments set updated_at = now() where id = target_project returning * into saved;
  -- Return the same project snapshot the list reads, including other users' edits.
  return to_jsonb(saved) || jsonb_build_object(
    'development_phases', (select jsonb_agg(p order by p.created_at, p.id) from public.development_phases p where p.development_id = target_project),
    'development_firmware', (select jsonb_agg(f order by f.row_no) from public.development_firmware f where f.development_id = target_project),
    'development_requirements', (select jsonb_agg(r order by r.row_no) from public.development_requirements r where r.development_id = target_project)
  );
end;
$$;

revoke all on function public.set_development_row_status(uuid,text,uuid,text,text) from public, anon;
grant execute on function public.set_development_row_status(uuid,text,uuid,text,text) to authenticated;
notify pgrst, 'reload schema';
