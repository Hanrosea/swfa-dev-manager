alter table public.development_firmware
  add constraint firmware_design_dates check (
    (design_start is null) = (design_end is null) and design_start <= design_end
  );
alter table public.developments add column legacy_deployment_date date;

create function public.deployment_after_qa(quality_end date)
returns date language sql immutable strict security invoker set search_path = '' as $$
  select quality_end + case extract(isodow from quality_end) when 5 then 3 when 6 then 2 else 1 end;
$$;
revoke all on function public.deployment_after_qa(date) from public, anon;
grant execute on function public.deployment_after_qa(date) to authenticated, service_role;
