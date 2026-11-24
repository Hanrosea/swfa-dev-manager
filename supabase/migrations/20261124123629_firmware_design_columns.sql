alter table public.development_firmware
  add column if not exists design_start date,
  add column if not exists design_end date;
