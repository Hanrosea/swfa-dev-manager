select pg_advisory_xact_lock(61124, 1);

-- Keep the existing transaction, optimistic lock, requirement handling and QA ranks in one place.
create schema development_internal;
grant usage on schema development_internal to authenticated, service_role;
alter function public.save_development_fw(jsonb,timestamptz) set schema development_internal;

create function public.save_development_fw(project jsonb, expected_updated_at timestamptz)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare
  saved_at timestamptz;
  next_deployment date;
begin
  if jsonb_typeof(project->'firmware') is distinct from 'array' then
    raise exception '개발 FW 목록을 확인해주세요.';
  end if;
  select public.deployment_after_qa(max(nullif(f->>'qaEnd', '')::date)) into next_deployment
  from jsonb_array_elements(project->'firmware') f;

  saved_at := development_internal.save_development_fw(
    project || jsonb_build_object('deploymentDate', next_deployment), expected_updated_at
  );

  -- A form opened on an older version omits design keys. An explicit empty pair clears the dates.
  update public.development_firmware fw
  set design_start = case when f ? 'designStart' then nullif(f->>'designStart', '')::date else fw.design_start end,
      design_end = case when f ? 'designEnd' then nullif(f->>'designEnd', '')::date else fw.design_end end
  from jsonb_array_elements(project->'firmware') f
  where fw.development_id = (project->>'id')::uuid and fw.id = (f->>'id')::uuid
    and (f ? 'designStart' or f ? 'designEnd');
  return saved_at;
end;
$$;
revoke all on function public.save_development_fw(jsonb,timestamptz) from public, anon;
grant execute on function public.save_development_fw(jsonb,timestamptz) to authenticated, service_role;
notify pgrst, 'reload schema';
