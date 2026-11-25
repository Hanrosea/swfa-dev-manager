alter table public.developments
  alter column effort_md set default '{"management":0,"design":0,"development":0,"quality":0,"deployment":0,"execution":0}'::jsonb,
  add constraint development_deployment_effort_nonnegative check (
    not (effort_md ? 'deployment') or case
      when jsonb_typeof(effort_md->'deployment') = 'number' then (effort_md->>'deployment')::numeric >= 0
      else false end
  );

-- An older client can save the five fields it knows after the new field has been populated.
create function development_internal.preserve_deployment_effort()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.effort_md := new.effort_md || jsonb_build_object('deployment', old.effort_md->'deployment');
  return new;
end;
$$;
revoke all on function development_internal.preserve_deployment_effort() from public;

create trigger developments_keep_deployment_effort
before update of effort_md on public.developments
for each row when (old.effort_md ? 'deployment' and not (new.effort_md ? 'deployment'))
execute function development_internal.preserve_deployment_effort();
