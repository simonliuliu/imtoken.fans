begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Existing content and review rows are not rewritten; the default revision is
-- a fresh concurrency baseline. Forum feedback is a separate deployment task.
do $$
begin
  if to_regprocedure('public.community_publication_xp()') is null then
    raise exception '0033 requires complete 0030';
  end if;
end;
$$;

lock table public.submissions, public.moderation_queue, public.xp_events,
  public.notifications, public.admin_logs in share row exclusive mode;
create temporary table moderation_before_submissions on commit drop as select to_jsonb(s) body from public.submissions s;
create temporary table moderation_before_queue on commit drop as select to_jsonb(q) body from public.moderation_queue q;
create temporary table moderation_before_xp on commit drop as select to_jsonb(x) body from public.xp_events x;
create temporary table moderation_before_notifications on commit drop as select to_jsonb(n) body from public.notifications n;
create temporary table moderation_before_logs on commit drop as select to_jsonb(l) body from public.admin_logs l;

alter table public.submissions add column moderation_revision integer not null default 0;
alter table public.moderation_queue add column submission_revision integer;
alter type public.moderation_result add value if not exists 'withdrawn';

-- Initial product creation and queue insertion are separate requests. Fence
-- the insert to the submission revision while holding the submission lock.
-- A skipped stale insert must not reopen a completed or superseded cycle.
create function public.submission_queue_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_status public.submission_status;
  v_deleted_at timestamptz;
  v_revision integer;
begin
  if new.target_type <> 'submission' or new.result <> 'pending' then return new; end if;
  if coalesce(current_setting('imtoken.moderation_restore', true), '') = new.target_id::text then return new; end if;
  select status, deleted_at, moderation_revision into v_status, v_deleted_at, v_revision
    from public.submissions where id = new.target_id for update;
  if not found or v_status <> 'pending' or v_deleted_at is not null then return null; end if;
  if new.submission_revision is null then
    if v_revision <> 0 then return null; end if;
    new.submission_revision := 0;
  elsif new.submission_revision <> v_revision then
    return null;
  end if;
  if exists (select 1 from public.moderation_queue q where q.target_type = 'submission'
      and q.target_id = new.target_id and q.result = 'pending'
      and coalesce(q.submission_revision, 0) = v_revision) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.submission_queue_guard() from public, anon, authenticated;
create trigger submission_queue_guard before insert on public.moderation_queue
for each row execute function public.submission_queue_guard();

-- Product creation and its first human review queue are one transaction.
-- A legacy app's later duplicate enqueue is safely skipped by the guard.
create function public.product_submission_enqueue() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.type = 'product' and new.status = 'pending' and new.deleted_at is null then
    insert into public.moderation_queue(target_type, target_id, source, result, submission_revision)
      values ('submission', new.id, 'human', 'pending', new.moderation_revision);
  end if;
  return new;
end;
$$;
revoke all on function public.product_submission_enqueue() from public, anon, authenticated;
create trigger product_submission_enqueue after insert on public.submissions
for each row execute function public.product_submission_enqueue();

-- An old application or an old AI callback must not bypass the transaction.
-- Soft delete/restore retain their existing semantics and advance the revision.
create function public.submission_moderation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_action text;
  v_xp record;
begin
  if new.moderation_revision is distinct from old.moderation_revision then
    raise exception 'moderation_revision_managed';
  end if;
  if old.deleted_at is null and new.deleted_at is not null then
    new.deleted_prev_status := old.status;
    new.status := 'rejected';
  elsif old.deleted_at is not null and new.deleted_at is null then
    new.status := coalesce(old.deleted_prev_status, 'pending');
  elsif old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
    raise exception 'moderation_conflict';
  end if;
  if new.status is distinct from old.status
     and new.deleted_at is not distinct from old.deleted_at
     and coalesce(current_setting('imtoken.moderation_transaction', true), '') <> 'on' then
    raise exception 'moderation_use_transaction';
  end if;
  if new.status is distinct from old.status or new.deleted_at is distinct from old.deleted_at then
    new.moderation_revision := old.moderation_revision + 1;
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    perform 1 from public.moderation_queue
      where target_type = 'submission' and target_id = old.id and result = 'pending'
      order by id for update;
    update public.moderation_queue set result = 'withdrawn', reviewed_at = now(),
      reviewed_by = case when new.deleted_at is not null then new.deleted_by else null end,
      reason = case when new.deleted_at is not null then '内容进入回收站，关闭本轮审核' else '恢复内容前关闭旧审核周期' end
      where target_type = 'submission' and target_id = old.id and result = 'pending';
    if new.deleted_at is null and new.status = 'pending' then
      perform set_config('imtoken.moderation_restore', old.id::text, true);
      insert into public.moderation_queue(target_type, target_id, source, result, submission_revision)
        values ('submission', old.id, 'human', 'pending', new.moderation_revision);
      perform set_config('imtoken.moderation_restore', '', true);
    end if;
    if old.type in ('product', 'idea') and not old.is_example and old.submitted_by is not null then
      v_action := case when old.type = 'product' then 'submission_product' else 'submission_idea' end;
      perform pg_advisory_xact_lock(hashtextextended(old.submitted_by::text, 1));
      if new.deleted_at is null and new.status = 'published' then
        select * into v_xp from public.award_xp_by_rule(old.submitted_by, v_action, 'submission', old.id, null);
        if v_xp.new_level > v_xp.old_level then
          insert into public.notifications(user_id, type, detail)
            values (old.submitted_by, 'level_up', jsonb_build_object('level', v_xp.new_level));
        end if;
      else
        perform public.revoke_xp(old.submitted_by, v_action, old.id);
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.submission_moderation_guard() from public, anon, authenticated;
create trigger submission_moderation_guard before update on public.submissions
for each row execute function public.submission_moderation_guard();

-- Append the revision to the existing security-invoker projection without
-- changing any previous column, visibility rule, or historical value.
create or replace view public.submission_cards with (security_invoker = on) as
select
  s.id, s.type, s.title, s.tagline, s.description, s.tags, s.status,
  s.submitted_by, s.stats_users, s.stats_dau, s.stats_updated_at,
  s.built_from_idea_id, s.created_at, s.updated_at,
  p.username as submitted_by_username, p.avatar_url as submitted_by_avatar_url,
  coalesce(vp.count, 0) as votes_paid, coalesce(vc.count, 0) as votes_creative,
  coalesce(inv.total, 0) as sim_invest_usd, coalesce(cm.count, 0) as comment_count,
  s.website_url, s.video_url, s.logo_path, s.screenshot_paths, s.team, s.social_links,
  p.role as submitted_by_role, s.deleted_at, p.level as submitted_by_level,
  s.product_platforms, s.pricing_type, s.launch_stage, s.maker_relationship,
  s.maker_note, s.feedback_prompt, s.published_at,
  coalesce(ps.count, 0) as support_count, coalesce(pr.count, 0) as rating_count,
  pr.average as rating_average,
  s.community_section, s.community_category, s.legacy_slug, s.is_example,
  s.example_author, s.example_content,
  (select count(*) from public.community_likes l where l.submission_id = s.id) as community_like_count,
  s.moderation_revision
from public.submissions s
left join public.profiles p on p.id = s.submitted_by
left join lateral (select count(*) as count from public.votes v where v.submission_id = s.id and v.vote_type = 'paid') vp on true
left join lateral (select count(*) as count from public.votes v where v.submission_id = s.id and v.vote_type = 'creative') vc on true
left join lateral (select coalesce(sum(i.amount), 0) as total from public.investments i where i.submission_id = s.id and i.type = 'simulated') inv on true
left join lateral (select count(*) as count from public.comments c where c.submission_id = s.id and c.status = 'published' and c.deleted_at is null) cm on true
left join lateral (select count(*) as count from public.product_supports x where x.submission_id = s.id) ps on true
left join lateral (select count(*) as count, round(avg(r.rating)::numeric, 1) as average from public.product_ratings r where r.submission_id = s.id) pr on true;

create function public.admin_moderate_submission(
  p_actor uuid,
  p_submission uuid,
  p_expected_revision integer,
  p_status text,
  p_queue uuid default null,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_submission public.submissions;
  v_actor_role public.user_role;
  v_actor_permissions jsonb;
  v_result public.moderation_result;
  v_xp record;
  v_action text;
  v_revision integer;
begin
  if p_actor is null or p_submission is null or p_status is null
     or p_status not in ('pending', 'published', 'rejected')
     or (p_reason is not null and char_length(p_reason) > 2000)
     or (p_queue is not null and p_status = 'pending') then
    raise exception 'moderation_invalid';
  end if;

  -- All paths lock the content before its pending queue, then let the existing
  -- publication trigger / XP functions lock the author and XP ledger.
  select * into v_submission from public.submissions where id = p_submission for update;
  if not found or v_submission.deleted_at is not null then
    raise exception 'moderation_unavailable';
  end if;
  perform 1 from public.moderation_queue
    where target_type = 'submission' and target_id = p_submission and result = 'pending'
    order by id for update;

  select role, permissions into v_actor_role, v_actor_permissions
    from public.profiles where id = p_actor;
  if not found or not coalesce(v_actor_role = 'admin' or
       (v_actor_role = 'member' and v_actor_permissions->'moderate_submissions' = 'true'::jsonb), false) then
    raise exception 'moderation_forbidden';
  end if;

  if p_queue is null then
    if p_expected_revision is null or p_expected_revision <> v_submission.moderation_revision
       or p_status = v_submission.status::text then
      raise exception 'moderation_conflict';
    end if;
  else
    if not exists (select 1 from public.moderation_queue where id = p_queue
        and target_type = 'submission' and target_id = p_submission and result = 'pending'
        and coalesce(submission_revision, 0) = v_submission.moderation_revision)
       or (v_submission.status::text <> 'pending' and v_submission.status::text <> p_status) then
      raise exception 'moderation_conflict';
    end if;
  end if;

  if v_submission.status::text <> p_status then
    perform set_config('imtoken.moderation_transaction', 'on', true);
    update public.submissions set status = p_status::public.submission_status
      where id = p_submission returning moderation_revision into v_revision;
    perform set_config('imtoken.moderation_transaction', 'off', true);
  else
    v_revision := v_submission.moderation_revision;
  end if;

  if p_status = 'pending' then
    -- Explicitly reconcile any stale pending records before opening a new
    -- cycle. The current actor and time identify this reconciliation only.
    update public.moderation_queue set result = 'withdrawn', reviewed_by = p_actor,
      reviewed_at = now(), reason = '管理员重新开启审核前关闭旧审核周期'
      where target_type = 'submission' and target_id = p_submission and result = 'pending';
    insert into public.moderation_queue(target_type, target_id, source, result, submission_revision)
      values ('submission', p_submission, 'human', 'pending', v_revision);
  else
    v_result := case when p_status = 'published' then 'approved'::public.moderation_result else 'rejected'::public.moderation_result end;
    update public.moderation_queue set result = v_result, reviewed_by = p_actor,
      reviewed_at = now(), reason = nullif(btrim(p_reason), '')
      where target_type = 'submission' and target_id = p_submission and result = 'pending';
  end if;

  -- Community posts and their notifications are handled by the 0030 trigger.
  -- Do not issue experience to examples or invent historical awards.
  if v_submission.type in ('product', 'idea') and not v_submission.is_example
     and v_submission.submitted_by is not null then
    v_action := case when v_submission.type = 'product' then 'submission_product' else 'submission_idea' end;
    perform pg_advisory_xact_lock(hashtextextended(v_submission.submitted_by::text, 1));
    if p_status = 'published' then
      select * into v_xp from public.award_xp_by_rule(v_submission.submitted_by, v_action, 'submission', p_submission, null);
      if v_xp.new_level > v_xp.old_level then
        insert into public.notifications(user_id, type, detail)
          values (v_submission.submitted_by, 'level_up', jsonb_build_object('level', v_xp.new_level));
      end if;
    else
      perform public.revoke_xp(v_submission.submitted_by, v_action, p_submission);
    end if;
  end if;

  insert into public.admin_logs(admin_id, action, target_type, target_id, detail)
    values (p_actor, 'submission_set_status_' || p_status, 'submission', p_submission,
      jsonb_build_object('previous_status', v_submission.status, 'queue_id', p_queue,
        'reason', nullif(btrim(p_reason), ''), 'revision', v_revision));
  return jsonb_build_object('revision', v_revision, 'author_id', v_submission.submitted_by);
end;
$$;
revoke all on function public.admin_moderate_submission(uuid, uuid, integer, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_moderate_submission(uuid, uuid, integer, text, uuid, text) to service_role;

do $$
begin
  if exists (select body from moderation_before_submissions except all select to_jsonb(s) - 'moderation_revision' from public.submissions s)
     or exists (select to_jsonb(s) - 'moderation_revision' from public.submissions s except all select body from moderation_before_submissions)
     or exists (select body from moderation_before_queue except all select to_jsonb(q) - 'submission_revision' from public.moderation_queue q)
     or exists (select to_jsonb(q) - 'submission_revision' from public.moderation_queue q except all select body from moderation_before_queue)
     or exists (select body from moderation_before_xp except all select to_jsonb(x) from public.xp_events x)
     or exists (select to_jsonb(x) from public.xp_events x except all select body from moderation_before_xp)
     or exists (select body from moderation_before_notifications except all select to_jsonb(n) from public.notifications n)
     or exists (select to_jsonb(n) from public.notifications n except all select body from moderation_before_notifications)
     or exists (select body from moderation_before_logs except all select to_jsonb(l) from public.admin_logs l)
     or exists (select to_jsonb(l) from public.admin_logs l except all select body from moderation_before_logs)
     or exists (select 1 from public.submissions where moderation_revision <> 0) then
    raise exception '0033 historical data verification failed';
  end if;
  if has_function_privilege('anon', 'public.admin_moderate_submission(uuid,uuid,integer,text,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.admin_moderate_submission(uuid,uuid,integer,text,uuid,text)', 'execute')
     or not has_function_privilege('service_role', 'public.admin_moderate_submission(uuid,uuid,integer,text,uuid,text)', 'execute')
     or has_function_privilege('anon', 'public.submission_moderation_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.submission_moderation_guard()', 'execute')
     or has_function_privilege('anon', 'public.submission_queue_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.submission_queue_guard()', 'execute')
     or has_function_privilege('anon', 'public.product_submission_enqueue()', 'execute')
     or has_function_privilege('authenticated', 'public.product_submission_enqueue()', 'execute') then
    raise exception '0033 function permission verification failed';
  end if;
end;
$$;

commit;
