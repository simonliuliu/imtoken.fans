-- Additive activity center, after 0031. Keep these records when rolling UI back: reward and
-- delivery receipts are permanent idempotency boundaries. No seeded campaigns.
begin;
-- Activity review eligibility relies on the original rating creation time.
-- Keep historical rows intact. Normal REST clients may still edit their text,
-- scores and tags, but cannot move an old review into a new activity window or
-- transfer it to another author/product. Privileged maintenance retains access.
create function public.activity_rating_origin_guard() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if current_user in ('anon','authenticated') then
  if tg_op='INSERT' then
   new.created_at:=statement_timestamp();
  elsif new.created_at is distinct from old.created_at or new.user_id is distinct from old.user_id or new.submission_id is distinct from old.submission_id or new.id is distinct from old.id then
   raise exception 'activity_rating_immutable';
  end if;
  new.updated_at:=statement_timestamp();
 end if;
 return new;
end; $$;
revoke all on function public.activity_rating_origin_guard() from public,anon,authenticated;
create trigger activity_rating_origin_guard before insert or update on public.product_ratings
 for each row execute function public.activity_rating_origin_guard();

create table public.community_activities (
 id uuid primary key default gen_random_uuid(), title text not null check(char_length(title) between 1 and 120),
 summary text not null default '' check(char_length(summary)<=300), body text not null check(char_length(body) between 20 and 20000),
 organizer text not null check(char_length(organizer) between 1 and 120),
 type text not null check(type in ('event','newcomer','weekly')),
 task_kind text not null check(task_kind in ('checkin','quiz','manual','product_review')),
 starts_at timestamptz not null, ends_at timestamptz not null check(ends_at>starts_at),
 status text not null default 'draft' check(status in ('draft','published','cancelled')),
 reward_xp integer not null default 0 check(reward_xp between 0 and 100000),
 reward_tickets integer not null default 0 check(reward_tickets between 0 and 10000),
 reward_badge text check(reward_badge in ('official','icoin','founder','moderator','partner','investor','mentor','beta_tester','top_contributor','event_winner')),
 reward_limit integer check(reward_limit between 1 and 1000000), rewarded_count integer not null default 0 check(rewarded_count>=0),
 checkin_days integer not null default 1 check(checkin_days between 1 and 366),
 quiz_question text check(char_length(quiz_question)<=1000), quiz_options jsonb not null default '[]'::jsonb check(jsonb_typeof(quiz_options)='array'),
 quiz_max_attempts integer not null default 3 check(quiz_max_attempts between 1 and 10),
 product_id uuid references public.submissions(id) on delete set null, cancel_reason text,
 created_by uuid references public.profiles(id) on delete set null, created_at timestamptz not null default now(), published_at timestamptz
);
create index community_activities_window on public.community_activities(status,starts_at desc);
create table public.activity_quiz_answers(activity_id uuid primary key references public.community_activities(id) on delete cascade, answer integer not null check(answer between 0 and 5));
create table public.activity_participations(
 activity_id uuid not null references public.community_activities(id), user_id uuid not null references public.profiles(id) on delete cascade,
 status text not null default 'joined' check(status in ('joined','submitted','approved','rejected')),
 evidence text check(char_length(evidence)<=2000), review_id uuid references public.product_ratings(id) on delete set null, attempts integer not null default 0,
 review_note text, joined_at timestamptz not null default now(), submitted_at timestamptz, reviewed_at timestamptz, reviewed_by uuid references public.profiles(id) on delete set null,
 primary key(activity_id,user_id)
);
create index activity_participations_review on public.activity_participations(status,submitted_at);
create table public.activity_rewards(
 activity_id uuid not null references public.community_activities(id),user_id uuid not null references public.profiles(id) on delete cascade,
 xp integer not null,tickets integer not null,badge text,created_at timestamptz not null default now(),primary key(activity_id,user_id)
);
create table public.activity_follows(activity_id uuid not null references public.community_activities(id),user_id uuid not null references public.profiles(id) on delete cascade,created_at timestamptz not null default now(),primary key(activity_id,user_id));
-- Receipt has no notification FK: clearing notifications must not replay events.
create table public.activity_notification_receipts(activity_id uuid not null references public.community_activities(id),user_id uuid not null references public.profiles(id) on delete cascade,kind text not null,created_at timestamptz not null default now(),primary key(activity_id,user_id,kind));
create table public.activity_notification_details(notification_id uuid primary key references public.notifications(id) on delete cascade,activity_id uuid not null references public.community_activities(id),kind text not null);
alter table public.community_activities enable row level security;
alter table public.activity_quiz_answers enable row level security;
alter table public.activity_participations enable row level security;
alter table public.activity_rewards enable row level security;
alter table public.activity_follows enable row level security;
alter table public.activity_notification_receipts enable row level security;
alter table public.activity_notification_details enable row level security;
revoke all on public.community_activities,public.activity_quiz_answers,public.activity_participations,public.activity_rewards,public.activity_follows,public.activity_notification_receipts,public.activity_notification_details from anon,authenticated;
grant select on public.community_activities to anon,authenticated;
create policy activity_public_read on public.community_activities for select using(status in ('published','cancelled'));

create function public.activity_require_user(p_expected uuid,p_admin boolean default false) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or auth.uid() is distinct from p_expected then raise exception 'activity_session'; end if;
 if p_admin and not exists(select 1 from profiles where id=auth.uid() and (role='admin' or role='member' and permissions->'manage_campaigns'='true'::jsonb)) then raise exception 'activity_forbidden'; end if;
end; $$;
create function public.activity_require_eligible(p_user uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from profiles where id=p_user and (muted_until is null or muted_until<=now())) or exists(select 1 from user_tags where user_id=p_user and tag_key='blacklisted') then raise exception 'activity_blocked'; end if;
end; $$;
create function public.activity_emit(p_activity uuid,p_user uuid,p_kind text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_rows integer;
begin
 insert into activity_notification_receipts(activity_id,user_id,kind) values(p_activity,p_user,p_kind) on conflict do nothing;
 get diagnostics v_rows=row_count;
 if v_rows=0 then return; end if;
 insert into notifications(user_id,type,event_key,detail) values(p_user,'xp_adjust','activity:'||p_activity||':'||p_user||':'||p_kind,jsonb_build_object('kind',p_kind)) returning id into v_id;
 insert into activity_notification_details(notification_id,activity_id,kind) values(v_id,p_activity,p_kind);
end; $$;
create function public.activity_award(p_activity uuid,p_user uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare a community_activities; p activity_participations; v_xp record; v_ticket record; v_has_reward boolean;
begin
 -- Every caller locks activity first, participation second. Shared cap is atomic.
 select * into a from community_activities where id=p_activity for update;
 select * into p from activity_participations where activity_id=p_activity and user_id=p_user for update;
 if p.status='approved' then return; end if;
 perform activity_require_eligible(p_user);
 v_has_reward:=a.reward_xp>0 or a.reward_tickets>0 or a.reward_badge is not null;
 if v_has_reward and a.reward_limit is not null and a.rewarded_count>=a.reward_limit then raise exception 'activity_reward_exhausted'; end if;
 if a.reward_xp>0 then
  select * into v_xp from award_xp(p_user,'community_activity',a.reward_xp,'activity',a.id,jsonb_build_object('activity_id',a.id));
  if v_xp.awarded<>a.reward_xp then raise exception 'activity_unavailable'; end if;
 end if;
 if a.reward_tickets>0 then
  select * into v_ticket from grant_lottery_tickets(p_user,a.reward_tickets,'community_activity',jsonb_build_object('activity_id',a.id));
  if v_ticket.changed<>a.reward_tickets then raise exception 'activity_unavailable'; end if;
 end if;
 if a.reward_badge is not null then insert into badges(user_id,badge_key,level,note) values(p_user,a.reward_badge,1,'社区活动奖励') on conflict(user_id,badge_key) do nothing; end if;
 insert into activity_rewards(activity_id,user_id,xp,tickets,badge) values(a.id,p_user,a.reward_xp,a.reward_tickets,a.reward_badge);
 update activity_participations set status='approved',reviewed_at=now() where activity_id=a.id and user_id=p_user;
 if v_has_reward then update community_activities set rewarded_count=rewarded_count+1 where id=a.id; end if;
 perform activity_emit(a.id,p_user,'activity_approved');
end; $$;

create function public.activity_read(p_expected_user_id uuid default null,p_activity_id uuid default null) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is distinct from p_expected_user_id then raise exception 'activity_session'; end if;
 return jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('product_available',a.task_kind<>'product_review' or exists(select 1 from submissions s where s.id=a.product_id and s.type='product' and s.status='published' and s.deleted_at is null)) order by a.starts_at desc) from community_activities a where a.status in ('published','cancelled') and (p_activity_id is null or a.id=p_activity_id)),'[]'::jsonb),
 'mine',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('following',exists(select 1 from activity_follows f where f.activity_id=p.activity_id and f.user_id=auth.uid()),'reward',(select to_jsonb(r) from activity_rewards r where r.activity_id=p.activity_id and r.user_id=auth.uid()))) from activity_participations p where p.user_id=auth.uid() and (p_activity_id is null or p.activity_id=p_activity_id)),'[]'::jsonb),
 'following',coalesce((select jsonb_agg(activity_id) from activity_follows where user_id=auth.uid()),'[]'::jsonb));
end; $$;
create function public.activity_write(p_expected_user_id uuid,p_activity_id uuid,p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a community_activities; p activity_participations; v_answer integer; v_review uuid; v_count integer;
begin
 perform activity_require_user(p_expected_user_id);
 select * into a from community_activities where id=p_activity_id and status in ('published','cancelled') for update;
 if not found then raise exception 'activity_unavailable'; end if;
 if p_action='unfollow' then delete from activity_follows where activity_id=a.id and user_id=auth.uid(); return jsonb_build_object('ok',true); end if;
 if a.status<>'published' then raise exception 'activity_unavailable'; end if;
 if p_action='follow' then
  if now()>=a.ends_at then raise exception 'activity_ended'; end if;
  insert into activity_follows(activity_id,user_id) values(a.id,auth.uid()) on conflict do nothing;
  -- A follow after start does not generate a historical start notification.
  if now()>=a.starts_at then insert into activity_notification_receipts(activity_id,user_id,kind) values(a.id,auth.uid(),'activity_started') on conflict do nothing; end if;
  return jsonb_build_object('ok',true);
 end if;
 perform activity_require_eligible(auth.uid());
 if now()<a.starts_at then raise exception 'activity_not_started'; end if;
 if now()>=a.ends_at then raise exception 'activity_ended'; end if;
 if p_action not in ('join','checkin','quiz','submit') then raise exception 'activity_invalid'; end if;
 insert into activity_participations(activity_id,user_id) values(a.id,auth.uid()) on conflict do nothing;
 select * into p from activity_participations where activity_id=a.id and user_id=auth.uid() for update;
 if p_action='join' or p.status='approved' then return jsonb_build_object('ok',true); end if;
 if p.status='submitted' then raise exception 'activity_already_submitted'; end if;
 if p_action='checkin' and a.task_kind='checkin' then
  select count(*) into v_count from checkins where user_id=auth.uid() and created_at>=a.starts_at and created_at<a.ends_at and checkin_date between (a.starts_at at time zone 'Asia/Shanghai')::date and ((a.ends_at-interval '1 microsecond') at time zone 'Asia/Shanghai')::date;
  if v_count<a.checkin_days then raise exception 'activity_checkin_missing'; end if;
  perform activity_award(a.id,auth.uid());
 elsif p_action='quiz' and a.task_kind='quiz' then
  if p.attempts>=a.quiz_max_attempts then raise exception 'activity_attempts_exhausted'; end if;
  v_answer:=(p_payload->>'answer')::integer;
  if v_answer is null or v_answer<0 or v_answer>=jsonb_array_length(a.quiz_options) then raise exception 'activity_invalid'; end if;
  update activity_participations set attempts=attempts+1 where activity_id=a.id and user_id=auth.uid();
  if v_answer is distinct from (select answer from activity_quiz_answers where activity_id=a.id) then return jsonb_build_object('ok',false,'error','activity_quiz_wrong'); end if;
  perform activity_award(a.id,auth.uid());
 elsif p_action='submit' and a.task_kind in ('manual','product_review') then
  if char_length(trim(coalesce(p_payload->>'evidence',''))) not between 20 and 2000 then raise exception 'activity_evidence'; end if;
  if a.task_kind='product_review' then
   select r.id into v_review from product_ratings r join submissions s on s.id=r.submission_id where r.submission_id=a.product_id and r.user_id=auth.uid() and r.experienced and r.created_at>=a.starts_at and r.created_at<a.ends_at and s.status='published' and s.deleted_at is null;
   if v_review is null then raise exception 'activity_review_missing'; end if;
  end if;
  update activity_participations set status='submitted',evidence=trim(p_payload->>'evidence'),review_id=v_review,review_note=null,submitted_at=now(),reviewed_at=null where activity_id=a.id and user_id=auth.uid();
 else raise exception 'activity_invalid'; end if;
 return jsonb_build_object('ok',true);
end; $$;

create function public.activity_admin_read(p_expected_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 perform activity_require_user(p_expected_user_id,true);
 return jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('quiz_answer',q.answer,'product_available',a.task_kind<>'product_review' or exists(select 1 from submissions s where s.id=a.product_id and s.type='product' and s.status='published' and s.deleted_at is null)) order by created_at desc) from community_activities a left join activity_quiz_answers q on q.activity_id=a.id),'[]'::jsonb),'participations',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('product_review',(select jsonb_build_object('body',r.body,'rating',r.rating,'created_at',r.created_at,'experienced',r.experienced,'submission_id',r.submission_id) from product_ratings r where r.id=p.review_id)) order by submitted_at desc nulls last) from activity_participations p),'[]'::jsonb),'rewards',coalesce((select jsonb_agg(to_jsonb(r) order by created_at desc) from activity_rewards r),'[]'::jsonb),'products',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title)) from submissions where type='product' and status='published' and deleted_at is null),'[]'::jsonb));
end; $$;
create function public.activity_admin_write(p_expected_user_id uuid,p_action text,p_activity_id uuid default null,p_payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a community_activities; p activity_participations; v_id uuid; v_user uuid; v_note text; v_before jsonb; v_after jsonb; v_old_answer integer;
begin
 perform activity_require_user(p_expected_user_id,true);
 if p_action='save' then
  if p_activity_id is not null then
   select * into a from community_activities where id=p_activity_id for update;
   if not found then raise exception 'activity_unavailable'; end if;
   if a.status<>'draft' then raise exception 'activity_frozen'; end if;
   v_before:=to_jsonb(a);
   select answer into v_old_answer from activity_quiz_answers where activity_id=a.id;
  end if;
  v_id:=coalesce(p_activity_id,gen_random_uuid());
  insert into community_activities(id,title,summary,body,organizer,type,task_kind,starts_at,ends_at,reward_xp,reward_tickets,reward_badge,reward_limit,checkin_days,quiz_question,quiz_options,quiz_max_attempts,product_id,created_by)
  values(v_id,trim(p_payload->>'title'),coalesce(p_payload->>'summary',''),p_payload->>'body',trim(p_payload->>'organizer'),p_payload->>'type',p_payload->>'task_kind',(p_payload->>'starts_at')::timestamptz,(p_payload->>'ends_at')::timestamptz,coalesce((p_payload->>'reward_xp')::integer,0),coalesce((p_payload->>'reward_tickets')::integer,0),nullif(p_payload->>'reward_badge',''),(p_payload->>'reward_limit')::integer,coalesce((p_payload->>'checkin_days')::integer,1),p_payload->>'quiz_question',coalesce(p_payload->'quiz_options','[]'::jsonb),coalesce((p_payload->>'quiz_max_attempts')::integer,3),(p_payload->>'product_id')::uuid,auth.uid())
  on conflict(id) do update set title=excluded.title,summary=excluded.summary,body=excluded.body,organizer=excluded.organizer,type=excluded.type,task_kind=excluded.task_kind,starts_at=excluded.starts_at,ends_at=excluded.ends_at,reward_xp=excluded.reward_xp,reward_tickets=excluded.reward_tickets,reward_badge=excluded.reward_badge,reward_limit=excluded.reward_limit,checkin_days=excluded.checkin_days,quiz_question=excluded.quiz_question,quiz_options=excluded.quiz_options,quiz_max_attempts=excluded.quiz_max_attempts,product_id=excluded.product_id;
  delete from activity_quiz_answers where activity_id=v_id;
  if p_payload->>'task_kind'='quiz' and p_payload->>'quiz_answer' is not null then insert into activity_quiz_answers(activity_id,answer) values(v_id,(p_payload->>'quiz_answer')::integer); end if;
  select to_jsonb(saved) into v_after from community_activities saved where id=v_id;
  if p_activity_id is null or v_before is distinct from v_after or v_old_answer is distinct from (select answer from activity_quiz_answers where activity_id=v_id) then
   insert into admin_logs(admin_id,action,target_type,target_id,detail) values(auth.uid(),case when p_activity_id is null then 'activity_draft_create' else 'activity_draft_save' end,'activity',v_id,jsonb_build_object('title',v_after->>'title','occurred_at',now(),'changed_fields',(select coalesce(jsonb_agg(key),'[]'::jsonb) from jsonb_each(v_after) fields where v_before->key is distinct from value),'quiz_answer_changed',v_old_answer is distinct from (select answer from activity_quiz_answers where activity_id=v_id)));
  end if;
  return jsonb_build_object('ok',true,'id',v_id);
 end if;
 select * into a from community_activities where id=p_activity_id for update;
 if not found then raise exception 'activity_unavailable'; end if;
 if p_action='publish' then
  if a.status<>'draft' then raise exception 'activity_frozen'; end if;
  if a.ends_at<=now() or (a.task_kind='quiz' and (coalesce(char_length(trim(a.quiz_question)),0)=0 or jsonb_array_length(a.quiz_options) not between 2 and 6 or exists(select 1 from jsonb_array_elements(a.quiz_options) opt where jsonb_typeof(opt)<>'string' or char_length(trim(opt#>>'{}')) not between 1 and 300) or not exists(select 1 from activity_quiz_answers where activity_id=a.id and answer<jsonb_array_length(a.quiz_options)))) or (a.task_kind='product_review' and not exists(select 1 from submissions where id=a.product_id and type='product' and status='published' and deleted_at is null)) then raise exception 'activity_invalid'; end if;
  update community_activities set status='published',published_at=now() where id=a.id;
 elsif p_action='cancel' then
  v_note:=trim(coalesce(p_payload->>'note',''));
  if a.status<>'published' or char_length(v_note) not between 5 and 1000 then raise exception 'activity_invalid'; end if;
  update community_activities set status='cancelled',cancel_reason=v_note where id=a.id;
  for v_user in select user_id from activity_follows where activity_id=a.id loop perform activity_emit(a.id,v_user,'activity_cancelled'); end loop;
 elsif p_action in ('approve','reject') then
  v_user:=(p_payload->>'user_id')::uuid;
  select * into p from activity_participations where activity_id=a.id and user_id=v_user for update;
  if p.status='approved' and p_action='approve' then return jsonb_build_object('ok',true); end if;
  if a.status<>'published' or p.status is distinct from 'submitted' or a.task_kind not in ('manual','product_review') then raise exception 'activity_invalid'; end if;
  v_note:=trim(coalesce(p_payload->>'note',''));
  if char_length(v_note)>1000 or (p_action='reject' and char_length(v_note)<5) then raise exception 'activity_invalid'; end if;
  if p_action='approve' then
   -- Recheck product existence, ownership and original creation window at review.
   if a.task_kind='product_review' and not exists(select 1 from product_ratings r join submissions s on s.id=r.submission_id where r.id=p.review_id and r.user_id=v_user and r.submission_id=a.product_id and r.experienced and r.created_at>=a.starts_at and r.created_at<a.ends_at and s.status='published' and s.deleted_at is null) then raise exception 'activity_review_missing'; end if;
   perform activity_award(a.id,v_user);
  else
   update activity_participations set status='rejected',reviewed_at=now() where activity_id=a.id and user_id=v_user;
   -- A new rejection after a correction is a separate event.
   perform activity_emit(a.id,v_user,'activity_rejected_'||extract(epoch from p.submitted_at)::text);
  end if;
  update activity_participations set review_note=v_note,reviewed_by=auth.uid() where activity_id=a.id and user_id=v_user;
 else raise exception 'activity_invalid'; end if;
 insert into admin_logs(admin_id,action,target_type,target_id,detail) values(auth.uid(),'activity_'||p_action,'activity',a.id,jsonb_strip_nulls(jsonb_build_object('occurred_at',now(),'target_user_id',case when p_action in ('approve','reject') then v_user end,'reason',v_note,'from_status',case when p_action in ('approve','reject') then p.status else a.status end,'to_status',case p_action when 'publish' then 'published' when 'cancel' then 'cancelled' when 'approve' then 'approved' when 'reject' then 'rejected' end,'reward',case when p_action='approve' then jsonb_build_object('xp',a.reward_xp,'tickets',a.reward_tickets,'badge',a.reward_badge) end)));
 return jsonb_build_object('ok',true,'id',a.id);
end; $$;

-- Extend 0028 projection instead of relying on detail fields it intentionally strips.
alter function public.notification_read(uuid,integer) rename to notification_read_before_activity;
revoke all on function public.notification_read_before_activity(uuid,integer) from public,anon,authenticated;
create function public.notification_read(p_expected_user_id uuid,p_offset integer default 0) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_data jsonb; v_items jsonb; v_activity uuid;
begin
 perform activity_require_user(p_expected_user_id);
 for v_activity in select a.id from community_activities a join activity_follows f on f.activity_id=a.id where f.user_id=auth.uid() and a.status='published' and a.starts_at<=now() order by a.id for update of a loop perform activity_emit(v_activity,auth.uid(),'activity_started'); end loop;
 v_data:=notification_read_before_activity(p_expected_user_id,p_offset);
 select coalesce(jsonb_agg(case when d.notification_id is null then item else item||jsonb_build_object('detail',jsonb_build_object('kind',case when d.kind like 'activity_rejected_%' then 'activity_rejected' else d.kind end,'activity_title',a.title,'activity_id',a.id),'href','/community/activities/'||a.id) end order by ord),'[]'::jsonb) into v_items from jsonb_array_elements(v_data->'items') with ordinality arr(item,ord) left join activity_notification_details d on d.notification_id=(item->>'id')::uuid left join community_activities a on a.id=d.activity_id;
 return jsonb_set(v_data,'{items}',v_items);
end; $$;

revoke all on function public.activity_require_user(uuid,boolean),public.activity_require_eligible(uuid),public.activity_emit(uuid,uuid,text),public.activity_award(uuid,uuid) from public,anon,authenticated;
revoke all on function public.activity_read(uuid,uuid),public.activity_write(uuid,uuid,text,jsonb),public.activity_admin_read(uuid),public.activity_admin_write(uuid,text,uuid,jsonb),public.notification_read(uuid,integer) from public,anon,authenticated;
grant execute on function public.activity_read(uuid,uuid) to anon,authenticated;
grant execute on function public.activity_write(uuid,uuid,text,jsonb),public.activity_admin_read(uuid),public.activity_admin_write(uuid,text,uuid,jsonb),public.notification_read(uuid,integer) to authenticated;
commit;
