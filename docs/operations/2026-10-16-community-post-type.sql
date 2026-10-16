-- Owner-authorized real community activation. No existing rows are overwritten.
-- 0029 MUST COMMIT before applying 0030.
begin;
set local lock_timeout='10s';
-- Apply and commit before 0030 uses the new enum value.
alter type public.submission_type add value if not exists 'post';

commit;
