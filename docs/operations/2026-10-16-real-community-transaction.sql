-- Reviewed activation of real community interaction. Run AFTER 0029 COMMIT.
-- Historical row snapshots are transaction-local, not independent disaster recovery.
begin;
set local lock_timeout='10s';
set local statement_timeout='90s';
lock table public.submissions,public.comments,public.profiles,public.notifications,public.xp_events,public.xp_rules,public.votes,public.admin_logs in share row exclusive mode;
create temporary table community_original on commit drop as
 select 'submissions' kind,id::text key,to_jsonb(t) payload from public.submissions t
 union all select 'comments',id::text,to_jsonb(t) from public.comments t
 union all select 'profiles',id::text,to_jsonb(t) from public.profiles t
 union all select 'notifications',id::text,to_jsonb(t) from public.notifications t
 union all select 'xp_events',id::text,to_jsonb(t) from public.xp_events t
 union all select 'xp_rules',action_key,to_jsonb(t) from public.xp_rules t
 union all select 'votes',id::text,to_jsonb(t) from public.votes t
 union all select 'admin_logs',id::text,to_jsonb(t) from public.admin_logs t;
-- Real community posts reuse historical submissions/comments and moderation governance.
alter table public.submissions alter column submitted_by drop not null;
alter table public.submissions add column community_section text, add column community_category text,
 add column legacy_slug text unique, add column is_example boolean not null default false,
 add column example_author text, add column example_content jsonb, add column request_id uuid;
alter table public.submissions add constraint community_post_shape check (
 (type <> 'post' and community_section is null and community_category is null and not is_example and submitted_by is not null)
 or (type='post' and community_section is not null and community_category is not null and (
 (community_section='safety' and community_category in ('stories','cases','guides','questionsSafety')) or
 (community_section='discussion' and community_category in ('questions','research','industry')) or
 (community_section='activities' and community_category in ('announcements','community','checkin')) or
 (community_section='feedback' and community_category in ('builds','changelog')))
 and ((is_example and submitted_by is null and example_author is not null and legacy_slug is not null)
 or (not is_example and submitted_by is not null and example_author is null and example_content is null))));
create unique index submissions_request_once on public.submissions(submitted_by,request_id) where request_id is not null;
alter table public.comments add column request_id uuid;
create unique index comments_request_once on public.comments(user_id,request_id) where request_id is not null;
-- All post writes go through the constrained RPC. Old product insert policy remains intact.
create policy community_post_rpc_only on public.submissions as restrictive for insert to authenticated with check(type<>'post');
-- Preserve legacy product comment INSERT during DB-first activation. New clients use the RPC.

create function public.community_actor(p_expected uuid) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or auth.uid() is distinct from p_expected then raise exception 'community_session'; end if;
 if not exists(select 1 from profiles where id=auth.uid() and (muted_until is null or muted_until<=now()))
 or exists(select 1 from user_tags where user_id=auth.uid() and tag_key='blacklisted') then raise exception 'community_blocked'; end if;
 return auth.uid();
end; $$;
revoke all on function public.community_actor(uuid) from public,anon,authenticated;

create function public.community_post_create(p_expected uuid,p_request uuid,p_section text,p_category text,p_title text,p_body text) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid; v_id uuid; v_old submissions;
begin
 v_actor:=community_actor(p_expected);
 if p_request is null or p_title is null or p_body is null or length(trim(p_title)) not between 2 and 80 or length(trim(p_body)) not between 10 and 5000
 or not coalesce((p_section='safety' and p_category in ('stories','cases','guides','questionsSafety')) or
 (p_section='discussion' and p_category in ('questions','research','industry')) or
 (p_section='activities' and p_category in ('community','checkin')),false) then raise exception 'community_invalid'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_actor::text,0));
 select * into v_old from submissions where submitted_by=v_actor and request_id=p_request;
 if found then
 if v_old.type<>'post' or v_old.title<>trim(p_title) or v_old.description<>trim(p_body) or v_old.community_section<>p_section or v_old.community_category<>p_category then raise exception 'community_replay'; end if;
 return v_old.id;
 end if;
 insert into submissions(type,title,tagline,description,submitted_by,community_section,community_category,request_id)
 values('post',trim(p_title),left(trim(p_body),160),trim(p_body),v_actor,p_section,p_category,p_request) returning id into v_id;
 insert into moderation_queue(target_type,target_id,source,result) values('submission',v_id,'human','pending');
 return v_id;
end; $$;
revoke all on function public.community_post_create(uuid,uuid,text,text,text,text) from public,anon;
grant execute on function public.community_post_create(uuid,uuid,text,text,text,text) to authenticated;

create function public.community_comment_create(p_expected uuid,p_request uuid,p_submission uuid,p_body text,p_parent uuid default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid; v_row comments; v_type submission_type; v_mode text;
begin
 v_actor:=community_actor(p_expected);
 if p_request is null or p_body is null or length(trim(p_body)) not between 2 and 2000 then raise exception 'community_invalid'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_actor::text,0));
 select * into v_row from comments where user_id=v_actor and request_id=p_request;
 if found then
 if v_row.submission_id<>p_submission or v_row.body<>trim(p_body) or v_row.parent_id is distinct from p_parent then raise exception 'community_replay'; end if;
 return to_jsonb(v_row)||jsonb_build_object('replayed',true,'community_post',exists(select 1 from submissions where id=v_row.submission_id and type='post'));
 end if;
 select type into v_type from submissions where id=p_submission and status='published' and deleted_at is null for share;
 if not found then raise exception 'community_unavailable'; end if;
 if p_parent is not null and not exists(select 1 from comments where id=p_parent and submission_id=p_submission and status='published' and deleted_at is null and community_comment_public(id)) then raise exception 'community_invalid'; end if;
 insert into comments(submission_id,user_id,parent_id,body,request_id) values(p_submission,v_actor,p_parent,trim(p_body),p_request) returning * into v_row;
 -- Every content type respects the shared comment moderation setting transactionally.
 select mode into v_mode from moderation_settings where target_type='comment';
 if v_mode='none' then update comments set status='published' where id=v_row.id returning * into v_row;
 else insert into moderation_queue(target_type,target_id,source,result) values('comment',v_row.id,case when v_mode='ai' then 'ai'::moderation_source else 'human'::moderation_source end,'pending'); end if;
 return to_jsonb(v_row)||jsonb_build_object('community_post',v_type='post','ai_pending',v_mode='ai');
end; $$;
revoke all on function public.community_comment_create(uuid,uuid,uuid,text,uuid) from public,anon;
grant execute on function public.community_comment_create(uuid,uuid,uuid,text,uuid) to authenticated;

create table public.community_likes(submission_id uuid references submissions(id) on delete cascade,user_id uuid references profiles(id) on delete cascade,created_at timestamptz not null default now(),primary key(submission_id,user_id));
alter table public.community_likes enable row level security;
create policy community_likes_read on public.community_likes for select using(exists(select 1 from submissions where id=submission_id and type='post' and status='published' and deleted_at is null));
grant select on public.community_likes to anon,authenticated;
create function public.community_like_write(p_expected uuid,p_submission uuid,p_liked boolean) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid;
begin
 v_actor:=community_actor(p_expected);
 if p_liked is null or not exists(select 1 from submissions where id=p_submission and type='post' and status='published' and deleted_at is null) then raise exception 'community_unavailable'; end if;
 if p_liked then insert into community_likes(submission_id,user_id) values(p_submission,v_actor) on conflict do nothing;
 else delete from community_likes where submission_id=p_submission and user_id=v_actor; end if;
 return p_liked;
end; $$;
revoke all on function public.community_like_write(uuid,uuid,boolean) from public,anon;
grant execute on function public.community_like_write(uuid,uuid,boolean) to authenticated;

-- Comment likes are desired-state writes, fenced to account and published targets.
create function public.community_comment_like_write(p_expected uuid,p_comment uuid,p_liked boolean) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid;
begin
 v_actor:=community_actor(p_expected);
 if p_liked is null or not exists(select 1 from comments c join submissions s on s.id=c.submission_id where c.id=p_comment and c.status='published' and c.deleted_at is null and s.status='published' and s.deleted_at is null and community_comment_public(c.id)) then raise exception 'community_unavailable'; end if;
 if p_liked then insert into comment_votes(comment_id,user_id) values(p_comment,v_actor) on conflict do nothing;
 else delete from comment_votes where comment_id=p_comment and user_id=v_actor; end if;
 return p_liked;
end; $$;
revoke all on function public.community_comment_like_write(uuid,uuid,boolean) from public,anon;
grant execute on function public.community_comment_like_write(uuid,uuid,boolean) to authenticated;
-- Legacy comment vote writes stay granted until the compatible app is deployed.

insert into xp_rules(action_key,amount,daily_cap) values('submission_post',20,5) on conflict do nothing;
-- Transactional XP for posts and their comments, covering every moderation entry point.
create function public.community_publication_xp() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid; v_action text; v_xp record;
begin
 if tg_table_name='submissions' then
 if new.type<>'post' or new.is_example then return new; end if;
 v_actor:=new.submitted_by; v_action:='submission_post';
 else
 if not exists(select 1 from submissions where id=new.submission_id and type='post') then return new; end if;
 v_actor:=new.user_id; v_action:='comment_posted';
 end if;
 if new.status<>'published' or new.deleted_at is not null then
 perform public.revoke_xp(v_actor,v_action,new.id);
 return new;
 end if;
 if tg_table_name='comments' then
 if not exists(select 1 from submissions where id=new.submission_id and status='published' and deleted_at is null) then return new; end if;
 end if;
 -- Serialize rule/day cap as well as event idempotency.
 perform pg_advisory_xact_lock(hashtextextended(v_actor::text,1));
 select * into v_xp from award_xp_by_rule(v_actor,v_action,case when tg_table_name='submissions' then 'submission' else 'comment' end,new.id,null);
 if v_xp.new_level>v_xp.old_level then insert into notifications(user_id,type,detail) values(v_actor,'level_up',jsonb_build_object('level',v_xp.new_level)); end if;
 return new;
end; $$;
revoke all on function public.community_publication_xp() from public,anon,authenticated;
create trigger community_post_xp after insert or update on submissions for each row execute function community_publication_xp();
create trigger community_comment_xp after insert or update on comments for each row execute function community_publication_xp();

create or replace view submission_cards
with (security_invoker = on) as
select
  s.id, s.type, s.title, s.tagline, s.description, s.tags, s.status,
  s.submitted_by, s.stats_users, s.stats_dau, s.stats_updated_at,
  s.built_from_idea_id, s.created_at, s.updated_at,
  p.username   as submitted_by_username,
  p.avatar_url as submitted_by_avatar_url,
  coalesce(vp.count, 0)  as votes_paid,
  coalesce(vc.count, 0)  as votes_creative,
  coalesce(inv.total, 0) as sim_invest_usd,
  coalesce(cm.count, 0)  as comment_count,
  s.website_url, s.video_url, s.logo_path, s.screenshot_paths, s.team, s.social_links,
  p.role as submitted_by_role,
  s.deleted_at,
  p.level as submitted_by_level,
  s.product_platforms,
  s.pricing_type,
  s.launch_stage,
  s.maker_relationship,
  s.maker_note,
  s.feedback_prompt,
  s.published_at,
  coalesce(ps.count, 0) as support_count,
  coalesce(pr.count, 0) as rating_count,
  pr.average as rating_average,
 s.community_section,s.community_category,s.legacy_slug,s.is_example,s.example_author,s.example_content,
 (select count(*) from community_likes l where l.submission_id=s.id) as community_like_count
from submissions s
left join profiles p on p.id = s.submitted_by
left join lateral (
  select count(*) as count from votes v
  where v.submission_id = s.id and v.vote_type = 'paid'
) vp on true
left join lateral (
  select count(*) as count from votes v
  where v.submission_id = s.id and v.vote_type = 'creative'
) vc on true
left join lateral (
  select coalesce(sum(i.amount), 0) as total from investments i
  where i.submission_id = s.id and i.type = 'simulated'
) inv on true
left join lateral (
  select count(*) as count from comments c
  where c.submission_id = s.id and c.status = 'published' and c.deleted_at is null
) cm on true
left join lateral (
  select count(*) as count from product_supports x where x.submission_id = s.id
) ps on true
left join lateral (
  select count(*) as count, round(avg(r.rating)::numeric, 1) as average
  from product_ratings r where r.submission_id = s.id
) pr on true;

grant select on submission_cards to anon, authenticated;

create or replace function public.notification_read(p_expected_user_id uuid,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_items jsonb;
begin
 if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'notification_session'; end if;
 if p_offset<0 or p_offset>100000 then raise exception 'notification_invalid'; end if;
 select coalesce(jsonb_agg(item order by created_at desc,id desc),'[]'::jsonb) into v_items from (
 select n.id,n.created_at,jsonb_build_object('id',n.id,'type',n.type,'read_at',n.read_at,'created_at',n.created_at,'detail',case when n.event_key is null then n.detail else jsonb_build_object('kind',n.detail->>'kind') end,
 'actor_username',a.username,'actor_avatar_url',a.avatar_url,
 'submission_id',s.id,'submission_type',s.type,'submission_title',coalesce(s.title,fp.title),
 'comment_id',coalesce(c.id,fc.id),'comment_preview',left(coalesce(c.body,fc.body),60),
 'href',case when fp.id is not null then '/community/feedback?category=wallet&idea='||fp.id||case when fc.id is not null then '&commentOffset='||((select count(*) from feedback_comments prev join feedback_posts origin on origin.id=prev.post_id where feedback_root(prev.post_id)=feedback_root(fp.id) and prev.visibility='published' and origin.visibility='published' and (prev.created_at,prev.id)<(fc.created_at,fc.id))/50*50)::text||'#comment-'||fc.id else '' end when s.id is not null then case when s.type='post' then '/community/'||s.community_section||'/'||coalesce(s.legacy_slug,s.id::text) else case when s.type='product' then '/products/' else '/ideas/' end||s.id end||case when c.id is not null then '#comment-'||c.id else '' end else null end) item
 from notifications n left join profiles a on a.id=n.actor_id
 left join submissions s on s.id=n.submission_id and s.status='published' and s.deleted_at is null
 left join comments c on c.id=n.comment_id and s.id is not null and c.status='published' and c.deleted_at is null and community_comment_public(c.id)
 left join feedback_posts fp on fp.id=n.feedback_post_id and fp.visibility='published' and exists(select 1 from feedback_posts root where root.id=feedback_root(fp.id) and root.visibility='published')
 left join feedback_comments fc on fc.id=n.feedback_comment_id and fp.id is not null and fc.visibility='published'
 where n.user_id=auth.uid() and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null and community_comment_public(x.id))) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published'))) order by n.created_at desc,n.id desc limit 20 offset p_offset
 ) rows;
 return jsonb_build_object('items',v_items,'unread',(select count(*) from notifications n where user_id=auth.uid() and read_at is null and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null and community_comment_public(x.id))) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published')))),'total',(select count(*) from notifications n where user_id=auth.uid() and (n.submission_id is null and n.feedback_post_id is null and n.comment_id is null and n.feedback_comment_id is null or
 n.submission_id is not null and exists(select 1 from submissions x where x.id=n.submission_id and x.status='published' and x.deleted_at is null) and (n.comment_id is null or exists(select 1 from comments x where x.id=n.comment_id and x.submission_id=n.submission_id and x.status='published' and x.deleted_at is null and community_comment_public(x.id))) or
 n.feedback_post_id is not null and exists(select 1 from feedback_posts x join feedback_posts root on root.id=feedback_root(x.id) where x.id=n.feedback_post_id and x.visibility='published' and root.visibility='published') and (n.feedback_comment_id is null or exists(select 1 from feedback_comments x where x.id=n.feedback_comment_id and x.visibility='published')))));
end; $$;

insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('15fcedba-7c4f-5561-87be-92311858cc5f','post','整理授权时，我会先记录这三个问题','不是看到授权就急着操作，先确认它为什么存在、是否还需要，以及哪里看不懂。','我给自己准备了一张纸质清单：这是哪一次使用留下的授权？现在还需要吗？我是否理解它的用途？这里只讨论检查思路，不展示任何个人钱包信息。

拿不准的地方先标记为待确认，不因为帖子里有人说“都可以取消”就照做。每个人使用的应用不同，具体操作前仍需核对应用说明。

如果把这个思路做成社区清单，你觉得最容易漏掉哪一项？欢迎用虚构场景交流，图片记得先遮挡敏感信息。','published','safety','guides','approval-checklist','lin','{"zh": {"title": "整理授权时，我会先记录这三个问题", "excerpt": "不是看到授权就急着操作，先确认它为什么存在、是否还需要，以及哪里看不懂。", "body1": "我给自己准备了一张纸质清单：这是哪一次使用留下的授权？现在还需要吗？我是否理解它的用途？这里只讨论检查思路，不展示任何个人钱包信息。", "body2": "拿不准的地方先标记为待确认，不因为帖子里有人说“都可以取消”就照做。每个人使用的应用不同，具体操作前仍需核对应用说明。", "body3": "如果把这个思路做成社区清单，你觉得最容易漏掉哪一项？欢迎用虚构场景交流，图片记得先遮挡敏感信息。", "poll": "你更希望清单先帮你解决什么？", "option1": "解释授权含义", "option2": "整理使用记录", "author": "林间小路"}, "en": {"title": "Three questions I ask before reviewing approvals", "excerpt": "Understand why an approval exists, whether it is still needed, and what remains unclear before acting.", "body1": "My fictional checklist asks: which interaction created this approval, do I still need it, and do I understand its purpose? No personal wallet information belongs in the discussion.", "body2": "When something is unclear, I mark it for verification rather than following a blanket suggestion to remove everything. Different applications have different requirements.", "body3": "What would you add to a community checklist? Use fictional scenarios and hide sensitive information in any images.", "poll": "What should a checklist explain first?", "option1": "What approvals mean", "option2": "How to organize records", "author": "Woodland Path"}}','2026-10-14T09:10:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('0036846e-f615-5a13-b152-759c6dae0bc7','post','第一次认真学习钱包，你会从哪一个概念开始？','地址、网络、授权……新词不少，我想先搭一个能慢慢补全的知识框架。','看到很多术语时，我不知道哪些需要先理解，哪些可以等遇到具体场景再深入。想听听大家是怎样开始学习的。

我倾向于一次只弄懂一个问题，再用自己的话复述。如果仍然需要大量陌生词来解释，可能说明我还没有真正理解。

不需要展示资产或使用记录。你可以分享自己的学习顺序，也可以给出一个适合新朋友提问的例子。','published','discussion','questions','first-wallet-question','river','{"zh": {"title": "第一次认真学习钱包，你会从哪一个概念开始？", "excerpt": "地址、网络、授权……新词不少，我想先搭一个能慢慢补全的知识框架。", "body1": "看到很多术语时，我不知道哪些需要先理解，哪些可以等遇到具体场景再深入。想听听大家是怎样开始学习的。", "body2": "我倾向于一次只弄懂一个问题，再用自己的话复述。如果仍然需要大量陌生词来解释，可能说明我还没有真正理解。", "body3": "不需要展示资产或使用记录。你可以分享自己的学习顺序，也可以给出一个适合新朋友提问的例子。", "poll": "哪种学习方式更适合你？", "option1": "按概念逐步学", "option2": "遇到场景再学", "author": "河岸笔记"}, "en": {"title": "Which concept would you learn first when starting with wallets?", "excerpt": "Addresses, networks, approvals: I would like a learning framework that can grow one question at a time.", "body1": "With so many unfamiliar words, it is difficult to know which ideas to understand first and which to explore in context. I would like to hear how others began learning.", "body2": "I prefer learning one concept and explaining it in my own words. If the explanation requires many more unfamiliar terms, I probably need another pass.", "body3": "There is no need to share assets or activity records. Share a learning sequence or a sample question that would help a newcomer.", "poll": "How do you prefer to learn?", "option1": "Concept by concept", "option2": "Through practical scenarios", "author": "River Notes"}}','2026-10-15T11:20:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('157d2efd-f7ca-57f7-a8e3-c1d7b4183745','post','周末交流室构想：带一个问题来聊聊','不讲大课，每人带一个使用中的疑问，试着把它变成大家都能看懂的问题。','这是一场尚未组织的虚拟活动构想，不是报名公告。设想用半小时，让几位朋友轮流描述一个使用疑问，其他人先提澄清问题。

讨论的重点是理解问题，不现场检查钱包，不要求屏幕共享，也不收集任何敏感信息。复杂问题可以整理为后续学习主题。

如果以后真的组织，时间、参与方式和规则需要另行发布。本帖先聊你希望这样的交流怎样进行，不承诺名额或奖励。','published','activities','community','weekend-conversation','moss','{"zh": {"title": "周末交流室构想：带一个问题来聊聊", "excerpt": "不讲大课，每人带一个使用中的疑问，试着把它变成大家都能看懂的问题。", "body1": "这是一场尚未组织的虚拟活动构想，不是报名公告。设想用半小时，让几位朋友轮流描述一个使用疑问，其他人先提澄清问题。", "body2": "讨论的重点是理解问题，不现场检查钱包，不要求屏幕共享，也不收集任何敏感信息。复杂问题可以整理为后续学习主题。", "body3": "如果以后真的组织，时间、参与方式和规则需要另行发布。本帖先聊你希望这样的交流怎样进行，不承诺名额或奖励。", "poll": "你更喜欢哪种交流形式？", "option1": "少人数主题讨论", "option2": "文字异步交流", "author": "青苔观察"}, "en": {"title": "Weekend conversation room: bring one question", "excerpt": "An activity concept where a small group turns everyday confusion into questions everyone can understand.", "body1": "This is a fictional proposal, not an event registration notice. Imagine a half-hour session where people describe one question and others first ask for clarification.", "body2": "The focus is understanding, not inspecting wallets. It would not require screen sharing or collecting sensitive information. Complex topics could become future learning notes.", "body3": "Any real event would need a separate schedule and participation rules. This post explores the format and promises no places or rewards.", "poll": "Which format would you prefer?", "option1": "Small themed conversations", "option2": "Asynchronous text discussion", "author": "Moss Observer"}}','2026-10-15T08:40:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('e3f293d3-0368-5130-9c76-4bc5e72b80de','post','收到“客服主动私信”时，我会先停下来','把突如其来的催促当作提醒：先核实信息来源，不在私聊里交出敏感信息。','以下为虚构案例：一位用户收到自称客服的私信，对方以“立即验证”为由催促配合。头像与名称看似熟悉，并不能证明身份已经核实。

我会先停止互动，自己查找可信入口核对信息。不会提供助记词、私钥或密码，也不会为了所谓“验证”按陌生人的要求操作。

分享类似经历时，请把账号、截图里的敏感字段和链接遮挡。大家可以讨论识别思路，避免传播可点击的可疑地址。','published','safety','cases','fake-support-message','summer','{"zh": {"title": "收到“客服主动私信”时，我会先停下来", "excerpt": "把突如其来的催促当作提醒：先核实信息来源，不在私聊里交出敏感信息。", "body1": "以下为虚构案例：一位用户收到自称客服的私信，对方以“立即验证”为由催促配合。头像与名称看似熟悉，并不能证明身份已经核实。", "body2": "我会先停止互动，自己查找可信入口核对信息。不会提供助记词、私钥或密码，也不会为了所谓“验证”按陌生人的要求操作。", "body3": "分享类似经历时，请把账号、截图里的敏感字段和链接遮挡。大家可以讨论识别思路，避免传播可点击的可疑地址。", "poll": "你想优先看到哪类防骗讨论？", "option1": "识别冒充身份", "option2": "识别催促话术", "author": "夏日微风"}, "en": {"title": "An unexpected support message is a reason to pause", "excerpt": "Verify the source independently. An urgent private message is not a reason to share sensitive information.", "body1": "Fictional case: a user receives an unsolicited message claiming to be support and demanding immediate verification. Familiar-looking names and avatars do not establish identity.", "body2": "I would stop the conversation and find a trusted source independently. I would never share a seed phrase, private key, or password, or follow an unfamiliar verification request.", "body3": "When discussing similar experiences, remove identifying details and unsafe links. Share the recognition process without spreading clickable suspicious addresses.", "poll": "Which topic would help you most?", "option1": "Recognizing impersonation", "option2": "Recognizing urgency tactics", "author": "Summer Breeze"}}','2026-10-13T15:10:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('1776d657-e532-58a4-bf70-7554afdc8864','post','「链上书签」：整理常用资料的工具构想','按网络和用途整理常用资料，不连接钱包、不读取资产；目前为作品构想，尚无可用产品。','「链上书签」是为展示社区产品区而编写的虚构作品，并没有可访问的真实产品。这份介绍中的创作者、功能和支持数均为示例，与 imToken 官方无产品关系。

这是用于展示社区内容形式的示例。可以在下方提交真实评论，审核通过后其他用户可见。

这是用于展示社区内容形式的示例。可以在下方提交真实评论，审核通过后其他用户可见。','published','feedback','builds','ai-explainer','lin','{"zh": {"title": "「链上书签」：整理常用资料的工具构想", "excerpt": "按网络和用途整理常用资料，不连接钱包、不读取资产；目前为作品构想，尚无可用产品。", "body1": "「链上书签」是为展示社区产品区而编写的虚构作品，并没有可访问的真实产品。这份介绍中的创作者、功能和支持数均为示例，与 imToken 官方无产品关系。", "body2": "这是用于展示社区内容形式的示例。可以在下方提交真实评论，审核通过后其他用户可见。", "body3": "这是用于展示社区内容形式的示例。可以在下方提交真实评论，审核通过后其他用户可见。", "poll": "你更希望先尝试哪个整理功能？", "option1": "按主题归档", "option2": "记录资料来源", "author": "林间小路"}, "en": {"title": "Chain Bookmarks: a concept for organizing useful resources", "excerpt": "Organize resources by network and purpose, without connecting a wallet or reading assets. A concept, with no available product yet.", "body1": "Chain Bookmarks is a fictional build created to demonstrate this community section. No real product is available. Its creator, features and support count are examples, with no official imToken product relationship.", "body2": "Imagine a resource folder saved on your device: manually add titles, purposes and source notes, then organize them by network or topic. No wallet connection, address or asset history is needed. Users must still check whether a link is trustworthy.", "body3": "This example illustrates a community article. Comments submitted below are saved and become visible to others after review.", "poll": "Which organizing feature would you try first?", "option1": "Group by topic", "option2": "Record sources", "author": "Woodland Path"}}','2026-10-14T14:20:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('fafb9acd-0437-58b5-aab9-f10cd4c357c1','post','产品公告样稿：让更新说明更好读','虚构公告排版示例，不对应真实版本，不代表官方发布。','这是用来展示产品公告区的虚构样稿，由虚拟作者演示文字结构。没有真实版本号、发布日期或官方发布身份，也不代表 imToken 已上线任何更新。

样稿可以先说明变化及使用影响，再列适用范围、注意事项和可核验的原始来源。真实公告未来必须由具有发布权限的人员填写，并单独确认版本与来源。

公告可关联已经处理的反馈，方便读者回看背景；发布公告本身不应自动把所有关联反馈改为已完成。本页不执行状态变更，只演示阅读和讨论。','published','feedback','changelog','reading-release-notes','river','{"zh": {"title": "产品公告样稿：让更新说明更好读", "excerpt": "虚构公告排版示例，不对应真实版本，不代表官方发布。", "body1": "这是用来展示产品公告区的虚构样稿，由虚拟作者演示文字结构。没有真实版本号、发布日期或官方发布身份，也不代表 imToken 已上线任何更新。", "body2": "样稿可以先说明变化及使用影响，再列适用范围、注意事项和可核验的原始来源。真实公告未来必须由具有发布权限的人员填写，并单独确认版本与来源。", "body3": "公告可关联已经处理的反馈，方便读者回看背景；发布公告本身不应自动把所有关联反馈改为已完成。本页不执行状态变更，只演示阅读和讨论。", "poll": "你读日志时最关心什么？", "option1": "变化对我的影响", "option2": "变化背后的原因", "author": "河岸笔记"}, "en": {"title": "Product update draft: make release notes easier to read", "excerpt": "A fictional announcement layout, with no actual release or official publication.", "body1": "This fictional sample demonstrates the product updates section through a made-up author. It has no real version, release date or official publisher identity, and announces no actual imToken change.", "body2": "A useful update can explain the change and its impact, then describe scope, precautions and a verifiable original source. Real announcements will require an authorized publisher to confirm the version and source.", "body3": "An announcement can link to processed feedback for context. Publishing it should not automatically mark every linked item as complete. This page only demonstrates reading and discussion, without changing statuses.", "poll": "What matters most in update notes?", "option1": "How a change affects me", "option2": "Why the change was made", "author": "River Notes"}}','2026-10-12T12:00:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('ea84b483-48da-5984-98d1-7b9a7cc05b9d','post','我的学习笔记模板：问题、出处、下一步','把收藏变成可复述的知识，先从一份三栏笔记开始。','我把每个新问题单独写成一行：我想弄懂什么、信息来自哪里、还需要核实什么。这样回过头看，比较容易知道自己究竟弄懂了多少。

阅读结束后先合上资料，尝试用自己的话写一段解释。哪些地方说不清，就回到原来的问题补查，而不是继续无限收藏。

社区里也可以按这个结构分享学习过程。观点和证据分开写，尚未核实的部分保留为问题，不把推测写成结论。','published','discussion','research','learning-notebook','moss','{"zh": {"title": "我的学习笔记模板：问题、出处、下一步", "excerpt": "把收藏变成可复述的知识，先从一份三栏笔记开始。", "body1": "我把每个新问题单独写成一行：我想弄懂什么、信息来自哪里、还需要核实什么。这样回过头看，比较容易知道自己究竟弄懂了多少。", "body2": "阅读结束后先合上资料，尝试用自己的话写一段解释。哪些地方说不清，就回到原来的问题补查，而不是继续无限收藏。", "body3": "社区里也可以按这个结构分享学习过程。观点和证据分开写，尚未核实的部分保留为问题，不把推测写成结论。", "poll": "你记笔记时更常遇到什么？", "option1": "资料太多难整理", "option2": "看懂了却说不清", "author": "青苔观察"}, "en": {"title": "A learning notebook: question, source, next step", "excerpt": "Turn saved links into knowledge you can explain, starting with three simple columns.", "body1": "I give each question its own row: what I want to understand, where the information came from, and what still needs checking. This makes it easier to see what I actually learned.", "body2": "After reading, I close the source and try to explain the idea. If something is unclear, I revisit that question instead of endlessly saving more links.", "body3": "The same structure could support community notes. Keep observations and interpretations separate, and leave unverified parts as questions.", "poll": "What makes note-taking harder?", "option1": "Too much material", "option2": "Difficulty explaining ideas", "author": "Moss Observer"}}','2026-10-14T18:30:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('e5e2c139-311d-546f-b941-85fd17f764a4','post','让签到成为回访社区的小提醒，而不是负担','交流一下习惯：比起只点一个按钮，我更想顺便看看有没有值得读的讨论。','有人喜欢固定时间回访，有人更愿意带着问题回来，两种方式都可以，不需要为了连续数字制造压力。

如果打开社区，可以先选择一篇感兴趣的帖子，再决定是否回复。签到与抽奖有现有独立页面，实际规则以该页面显示为准。

我喜欢可以自己调整频率的提醒：忙的时候不打扰，有感兴趣的讨论再回来看看。你觉得怎样的提醒既有用又自然？','published','activities','checkin','checkin-routine','river','{"zh": {"title": "让签到成为回访社区的小提醒，而不是负担", "excerpt": "交流一下习惯：比起只点一个按钮，我更想顺便看看有没有值得读的讨论。", "body1": "有人喜欢固定时间回访，有人更愿意带着问题回来，两种方式都可以，不需要为了连续数字制造压力。", "body2": "如果打开社区，可以先选择一篇感兴趣的帖子，再决定是否回复。签到与抽奖有现有独立页面，实际规则以该页面显示为准。", "body3": "我喜欢可以自己调整频率的提醒：忙的时候不打扰，有感兴趣的讨论再回来看看。你觉得怎样的提醒既有用又自然？", "poll": "哪种回访方式更自然？", "option1": "有话题时回来", "option2": "固定时间看看", "author": "河岸笔记"}, "en": {"title": "A check-in can be a gentle reason to revisit a conversation", "excerpt": "I would rather find something worth reading than feel obliged to press a daily button.", "body1": "Some people prefer a routine; others return with a question. Both approaches are useful, and neither needs pressure from a streak.", "body2": "On a visit, choose a conversation that interests you and decide whether to reply. Existing check-in and lucky draw pages have their own actual rules.", "body3": "I prefer reminders with a frequency I can control: quiet when I am busy, useful when a conversation interests me. What would feel natural to you?", "poll": "How would you prefer to return?", "option1": "When a topic interests me", "option2": "At a regular time", "author": "River Notes"}}','2026-10-13T07:20:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('6de7de4a-8b1c-5421-badc-309813cd5d4c','post','看见陌生网络名称，怎样把求助问题说清楚？','求助时描述你看到了什么和想做什么，比发一张未经处理的整屏截图更有帮助。','我会先写清页面里出现的提示、自己原本想完成的动作，以及问题发生前最后一个明确步骤。比起“怎么用不了”，这样的描述更容易继续沟通。

不需要发送地址、余额、助记词或私钥。若确实需要图片辅助说明，应先遮挡敏感信息，只保留与问题有关的界面部分。

社区回复可以先帮忙梳理概念。涉及具体操作时，仍需通过可信资料核对，不要根据不明私信直接行动。','published','safety','questionsSafety','network-help','moss','{"zh": {"title": "看见陌生网络名称，怎样把求助问题说清楚？", "excerpt": "求助时描述你看到了什么和想做什么，比发一张未经处理的整屏截图更有帮助。", "body1": "我会先写清页面里出现的提示、自己原本想完成的动作，以及问题发生前最后一个明确步骤。比起“怎么用不了”，这样的描述更容易继续沟通。", "body2": "不需要发送地址、余额、助记词或私钥。若确实需要图片辅助说明，应先遮挡敏感信息，只保留与问题有关的界面部分。", "body3": "社区回复可以先帮忙梳理概念。涉及具体操作时，仍需通过可信资料核对，不要根据不明私信直接行动。", "poll": "你希望求助模板先提示什么？", "option1": "如何描述问题", "option2": "如何保护隐私", "author": "青苔观察"}, "en": {"title": "An unfamiliar network name: how can I ask a clear question?", "excerpt": "Describe what you saw and what you intended to do before sharing an unedited screenshot.", "body1": "I would describe the visible message, the intended action, and the last clear step before the confusion. That gives others more to work with than simply saying something does not work.", "body2": "There is no need to share an address, balance, seed phrase, or private key. If an image helps, hide sensitive information and keep only the relevant part.", "body3": "A community reply can help clarify concepts. Verify any concrete action through trusted material instead of following unsolicited private messages.", "poll": "What should a help template explain first?", "option1": "Describing the issue", "option2": "Protecting privacy", "author": "Moss Observer"}}','2026-10-12T16:00:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('823873e3-9ada-576c-a900-b93b437c2fa4','post','讨论新趋势时，我想先问：解决了什么问题？','把新名词放回具体场景，或许比急着下结论更有价值。','遇到一个热门概念，我想先找一个能明确描述的使用场景，再看它与现有方式有什么不同。抽象的名词有时需要一个具体问题才能解释清楚。

讨论可以区分已经可观察到的行为、团队的目标和我们自己的推测。缺少证据的部分写成待确认，方便后来继续补充。

如果你也有类似方法，欢迎分享提问框架。这里不需要预测价格，也不需要用资产规模证明观点。','published','discussion','industry','better-questions','summer','{"zh": {"title": "讨论新趋势时，我想先问：解决了什么问题？", "excerpt": "把新名词放回具体场景，或许比急着下结论更有价值。", "body1": "遇到一个热门概念，我想先找一个能明确描述的使用场景，再看它与现有方式有什么不同。抽象的名词有时需要一个具体问题才能解释清楚。", "body2": "讨论可以区分已经可观察到的行为、团队的目标和我们自己的推测。缺少证据的部分写成待确认，方便后来继续补充。", "body3": "如果你也有类似方法，欢迎分享提问框架。这里不需要预测价格，也不需要用资产规模证明观点。", "poll": "你会先追问哪个问题？", "option1": "具体解决了什么", "option2": "有哪些可核实证据", "author": "夏日微风"}, "en": {"title": "Before discussing a trend, I ask what problem it solves", "excerpt": "Putting a new term in a concrete context may be more useful than rushing to a conclusion.", "body1": "When I encounter a popular concept, I first try to describe one use case and compare it with an existing approach. A concrete question can make an abstract term much easier to discuss.", "body2": "Separate observable behavior, a team’s stated goal, and our own assumptions. Mark unsupported parts for verification so the discussion can improve over time.", "body3": "Share a questioning framework if you have one. There is no need for price predictions or asset figures to support a perspective.", "poll": "What would you ask first?", "option1": "Which problem it solves", "option2": "What evidence is available", "author": "Summer Breeze"}}','2026-10-11T09:40:00+08:00',true) on conflict(id) do nothing;
insert into submissions(id,type,title,tagline,description,status,community_section,community_category,legacy_slug,example_author,example_content,created_at,is_example) values('c6ae2174-ac6f-5560-8a2e-20b6a51a5407','post','活动提案：用自己的话解释一个钱包名词','一份文字共学活动构想，不设奖品，也不要求提供任何钱包信息。','设想每位参与者选择一个术语，用不超过一段话解释给新朋友。其他人指出哪里难懂，再一起改得更清楚。此处没有真实报名或已定档活动。

示例可以完全虚构，重点是表达和理解。不要提交真实钱包截图，也不要把某一种操作方式包装成适合所有人的唯一答案。

如果未来开展，运营需要另行确认组织方式和时间。现在先聊聊：是大家围绕同一个术语一起改写更好，还是每个人选择自己最近刚弄懂的词？','published','activities','announcements','reading-circle','lin','{"zh": {"title": "活动提案：用自己的话解释一个钱包名词", "excerpt": "一份文字共学活动构想，不设奖品，也不要求提供任何钱包信息。", "body1": "设想每位参与者选择一个术语，用不超过一段话解释给新朋友。其他人指出哪里难懂，再一起改得更清楚。此处没有真实报名或已定档活动。", "body2": "示例可以完全虚构，重点是表达和理解。不要提交真实钱包截图，也不要把某一种操作方式包装成适合所有人的唯一答案。", "body3": "如果未来开展，运营需要另行确认组织方式和时间。现在先聊聊：是大家围绕同一个术语一起改写更好，还是每个人选择自己最近刚弄懂的词？", "poll": "你更喜欢哪种共学方式？", "option1": "每次一个共同主题", "option2": "每人自选一个术语", "author": "林间小路"}, "en": {"title": "Activity proposal: explain one wallet term in your own words", "excerpt": "A text-based learning concept with no prizes and no requests for wallet information.", "body1": "Each person could choose a term and explain it in a short paragraph. Others could point out unclear wording and help improve it. There is no real registration or confirmed schedule here.", "body2": "Examples can be entirely fictional. The focus is understanding and expression. Do not submit wallet screenshots or suggest one approach fits everyone.", "body3": "Any future event would need separately confirmed arrangements. For now, would you prefer rewriting one shared term together or choosing something you recently learned?", "poll": "Which learning format appeals to you?", "option1": "One shared topic each time", "option2": "A term chosen by each person", "author": "Woodland Path"}}','2026-10-11T17:10:00+08:00',true) on conflict(id) do nothing;

notify pgrst, 'reload schema';

create function public.community_comment_public(p_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 with recursive chain as (
 select c.id,c.parent_id,c.status,c.deleted_at,c.submission_id from comments c where c.id=p_id
 union all select p.id,p.parent_id,p.status,p.deleted_at,p.submission_id from comments p join chain on p.id=chain.parent_id
 ) select exists(select 1 from chain) and not exists(select 1 from chain where status<>'published' or deleted_at is not null)
 and exists(select 1 from submissions s join chain on chain.submission_id=s.id where s.status='published' and s.deleted_at is null);
$$;
revoke all on function public.community_comment_public(uuid) from public;
grant execute on function public.community_comment_public(uuid) to anon,authenticated;
create policy community_comment_read_guard on public.comments as restrictive for select to anon,authenticated
 using (user_id=auth.uid() or public.is_admin() or public.community_comment_public(id));
create policy community_comment_votes_read_guard on public.comment_votes as restrictive for select to anon,authenticated
 using (public.community_comment_public(comment_id));
notify pgrst, 'reload schema';

-- Compatibility: existing published product/idea pages can still post pending comments
-- and toggle public votes while the new app awaits review/deployment.
create policy community_comment_ancestor_insert_guard on public.comments as restrictive for insert to authenticated
 with check(parent_id is null or public.community_comment_public(parent_id));
create policy community_comment_vote_insert_guard on public.comment_votes as restrictive for insert to authenticated
 with check(user_id=auth.uid() and community_comment_public(comment_id)
 and exists(select 1 from profiles p where p.id=auth.uid() and (p.muted_until is null or p.muted_until<=now()))
 and not exists(select 1 from user_tags where user_id=auth.uid() and tag_key='blacklisted'));
create policy community_comment_vote_delete_guard on public.comment_votes as restrictive for delete to authenticated
 using(user_id=auth.uid() and community_comment_public(comment_id)
 and exists(select 1 from profiles p where p.id=auth.uid() and (p.muted_until is null or p.muted_until<=now()))
 and not exists(select 1 from user_tags where user_id=auth.uid() and tag_key='blacklisted'));
notify pgrst, 'reload schema';

-- Preserve all pre-existing values. Added columns are intentionally ignored.
do $$
begin
 if exists(select 1 from community_original old left join (
 select 'submissions' kind,id::text key,to_jsonb(t) payload from public.submissions t
 union all select 'comments',id::text,to_jsonb(t) from public.comments t
 union all select 'profiles',id::text,to_jsonb(t) from public.profiles t
 union all select 'notifications',id::text,to_jsonb(t) from public.notifications t
 union all select 'xp_events',id::text,to_jsonb(t) from public.xp_events t
 union all select 'xp_rules',action_key,to_jsonb(t) from public.xp_rules t
 union all select 'votes',id::text,to_jsonb(t) from public.votes t
 union all select 'admin_logs',id::text,to_jsonb(t) from public.admin_logs t
 ) current using(kind,key) where current.key is null or not current.payload @> old.payload)
 then raise exception 'Historical rows changed; refusing activation'; end if;
 if (select count(*) from public.submissions where type='post' and is_example)<>11
 then raise exception 'Unexpected community seed count'; end if;
 if not has_table_privilege('authenticated','public.comments','INSERT')
 or not has_table_privilege('authenticated','public.comment_votes','INSERT')
 then raise exception 'Legacy product comments would be interrupted'; end if;
 if has_function_privilege('anon','public.community_post_create(uuid,uuid,text,text,text,text)','EXECUTE')
 or has_function_privilege('authenticated','public.community_actor(uuid)','EXECUTE')
 then raise exception 'Unexpected public/helper write privileges'; end if;
end $$;
select kind,count(*) preserved_rows from community_original group by kind order by kind;
commit;
