select pg_advisory_xact_lock(61124, 1);

-- Preserve every manual date that this one-time recalculation replaces.
with derived as (
  select d.id, public.deployment_after_qa(max(f.qa_end)) as next_release
  from public.developments d left join public.development_firmware f on f.development_id = d.id
  where d.deleted_at is null
  group by d.id
)
update public.developments d
set legacy_deployment_date = coalesce(d.legacy_deployment_date, d.deployment_date),
    deployment_date = derived.next_release
from derived
where d.id = derived.id and d.deployment_date is distinct from derived.next_release;
