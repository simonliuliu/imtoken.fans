-- Read-only catalog preflight. Run in the existing project's SQL Editor before
-- selecting a controlled migration path. It returns no feedback bodies or keys.
select
  timezone('Asia/Singapore', now()) as inspected_at,
  current_database() as database_name,
  to_regprocedure('public.community_post_create(uuid,uuid,text,text,text,text)') is not null as community_0030_present,
  to_regprocedure('public.feedback_text_trim(text)') is not null as review_0031_helper_present,
  (
    select count(*)::integer
    from pg_constraint c
    join pg_class t on t.oid=c.conrelid
    join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public'
      and (
        (t.relname='feedback_posts' and c.conname in ('feedback_posts_review_title_check','feedback_posts_review_description_check'))
        or (t.relname='feedback_comments' and c.conname='feedback_comments_review_body_check')
      )
  ) as review_0031_constraint_count,
  to_regclass('public.forum_feedback_jobs') is not null as forum_jobs_present;

select t.relname as table_name,c.conname,c.convalidated,pg_get_constraintdef(c.oid) as definition
from pg_constraint c
join pg_class t on t.oid=c.conrelid
join pg_namespace n on n.oid=t.relnamespace
where n.nspname='public'
  and t.relname in ('feedback_posts','feedback_comments')
order by t.relname,c.conname;

select p.proname,p.oid::regprocedure as signature,p.prosecdef,p.proconfig,p.proacl::text as acl,md5(p.prosrc) as source_checksum
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('feedback_actor','feedback_card','feedback_root','feedback_read','feedback_write','feedback_text_trim','emit_content_notification','notification_read')
order by p.proname,p.oid;

select 'feedback_posts' as relation_name,count(*)::bigint as row_count from public.feedback_posts
union all select 'feedback_comments',count(*)::bigint from public.feedback_comments
union all select 'feedback_post_votes',count(*)::bigint from public.feedback_post_votes
union all select 'feedback_comment_votes',count(*)::bigint from public.feedback_comment_votes
union all select 'feedback_merges',count(*)::bigint from public.feedback_merges
union all select 'feedback_audit',count(*)::bigint from public.feedback_audit
union all select 'notifications',count(*)::bigint from public.notifications
union all select 'notification_events',count(*)::bigint from public.notification_events;

-- Migration selection is deliberately explicit:
-- helper=false AND constraint_count=0: review/install 0031, then install 0032.
-- helper=true  AND constraint_count=3: preserve 0031, install only 0032.
-- Any partial result or unexpected source/ACL: stop and reconcile the catalog.
-- forum_jobs_present=true: reconcile installed 0032 before any repeated CREATE.
