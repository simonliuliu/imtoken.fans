-- Read-only preflight. Reports aggregate counts and schema metadata only;
-- it does not return user identifiers, content, credentials or access tokens.
begin read only;

select table_name, column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('submissions', 'moderation_queue', 'xp_events', 'notifications', 'admin_logs')
  and column_name in ('id', 'type', 'status', 'submitted_by', 'is_example', 'deleted_at', 'deleted_by', 'deleted_prev_status', 'moderation_revision', 'submission_revision', 'target_type', 'target_id', 'source', 'result', 'reviewed_by', 'reviewed_at', 'user_id', 'action', 'ref_id', 'revoked_at')
order by table_name, ordinal_position;

select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'submissions' and not t.tgisinternal
order by t.tgname;

select p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig,
  md5(pg_get_functiondef(p.oid)) as definition_checksum
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('community_publication_xp', 'award_xp_by_rule', 'revoke_xp', 'submission_moderation_guard', 'submission_queue_guard', 'product_submission_enqueue', 'admin_moderate_submission')
order by signature;

select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public' and t.typname = 'moderation_result' order by e.enumsortorder;

select c.reloptions, md5(pg_get_viewdef(c.oid, true)) as definition_checksum
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'submission_cards';

select 'submissions' as name, count(*) as total from public.submissions
union all select 'moderation_queue', count(*) from public.moderation_queue
union all select 'xp_events', count(*) from public.xp_events
union all select 'notifications', count(*) from public.notifications
union all select 'admin_logs', count(*) from public.admin_logs;

select s.type, s.status, count(*) as stale_pending_queue_rows
from public.moderation_queue q join public.submissions s on s.id = q.target_id
where q.target_type = 'submission' and q.result = 'pending'
  and (s.status <> 'pending' or s.deleted_at is not null)
group by s.type, s.status order by s.type, s.status;

select count(*) as targets_with_multiple_pending_rows
from (select target_id from public.moderation_queue where target_type = 'submission' and result = 'pending'
      group by target_id having count(*) > 1) duplicates;

rollback;
