-- Read-only checks for the operator AFTER 0026 has committed.
-- Capture the first counts before applying the migration as a baseline too.
-- No credentials, message bodies or profile details are selected.
select 'notifications' as entity, count(*) as rows from public.notifications
union all select 'submissions', count(*) from public.submissions
union all select 'comments', count(*) from public.comments
union all select 'feedback_posts', count(*) from public.feedback_posts
union all select 'feedback_comments', count(*) from public.feedback_comments;

select enumlabel from pg_enum
where enumtypid = 'public.notification_type'::regtype
order by enumsortorder;

select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('user_follows','notification_events','notifications');

-- All three expected false; RPC owns reads and read_at/clear mutations.
select r.role,
  has_table_privilege(r.role, 'public.notifications', 'SELECT') as direct_select,
  has_table_privilege(r.role, 'public.notifications', 'UPDATE') as direct_update,
  has_table_privilege(r.role, 'public.notifications', 'DELETE') as direct_delete
from (values ('anon'), ('authenticated')) r(role);

-- anon: only follow_read true. authenticated: four RPCs true, both helpers false.
select r.role, p.signature, has_function_privilege(r.role, p.signature, 'EXECUTE') as allowed
from (values ('anon'), ('authenticated')) r(role)
cross join (values
 ('public.follow_read(uuid,uuid)'),
 ('public.follow_write(uuid,uuid,boolean,boolean,boolean)'),
 ('public.notification_read(uuid,integer)'),
 ('public.notification_write(uuid,text,uuid)'),
 ('public.emit_content_notification()'),
 ('public.notification_legacy_insert_guard()')
) p(signature);

select policyname, permissive, cmd from pg_policies
where schemaname = 'public' and tablename = 'comments'
  and policyname = 'comments_insert_notification_guard';
