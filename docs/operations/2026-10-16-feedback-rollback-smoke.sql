-- Target-schema RPC smoke only. Existing account IDs stay server-side.
-- All feedback writes are rolled back; no user/role changes, no persistent test posts.
begin;
set local statement_timeout = '30s';
do $$
declare u uuid; a uuid; p uuid:=gen_random_uuid(); q uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); m uuid; r jsonb; rejected boolean:=false;
begin
 select id into u from public.profiles x where role='user' and (muted_until is null or muted_until<now()) and not exists(select 1 from public.user_tags t where t.user_id=x.id and tag_key='blacklisted') limit 1;
 select id into a from public.profiles x where role='admin' and (muted_until is null or muted_until<now()) and not exists(select 1 from public.user_tags t where t.user_id=x.id and tag_key='blacklisted') limit 1;
 if u is null or a is null then raise exception 'Missing existing ordinary/admin actor'; end if;
 perform set_config('request.jwt.claim.sub',u::text,true);
 perform public.feedback_write('create',jsonb_build_object('id',p,'title','Integration rollback smoke','description','Temporary transaction only','module','wallet'));
 perform public.feedback_write('create',jsonb_build_object('id',q,'title','Second rollback smoke','description','Temporary transaction only','module','wallet'));
 perform public.feedback_write('vote',jsonb_build_object('id',p,'supported',true));
 perform public.feedback_write('vote',jsonb_build_object('id',p,'supported',true));
 perform public.feedback_write('comment',jsonb_build_object('id',p,'body','Temporary comment','request_id',c));
 perform public.feedback_write('comment_vote',jsonb_build_object('id',c,'supported',true));
 if (select count(*) from public.feedback_post_votes where post_id=p)<>1 then raise exception 'Vote not idempotent'; end if;
 r:=public.feedback_read(p);
 if r->'selected'->>'title'<>'Integration rollback smoke' then raise exception 'Read after write failed'; end if;
 begin
  perform public.feedback_write('edit',jsonb_build_object('id',p,'version',1,'title','Forbidden ordinary edit','description','Temporary transaction only','module','wallet','status','done','mark','none','visibility','published'));
 exception when others then if sqlerrm like '%feedback_forbidden%' then rejected:=true; else raise; end if; end;
 if not rejected then raise exception 'Ordinary actor gained admin edit'; end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 perform public.feedback_write('edit',jsonb_build_object('id',p,'version',1,'title','Admin rollback edit','description','Temporary transaction only','module','wallet','status','evaluating','mark','research','visibility','published'));
 if (select title from public.feedback_posts where id=p)<>'Admin rollback edit' then raise exception 'Admin edit missing'; end if;
 perform public.feedback_write('merge',jsonb_build_object('id',p,'version',2,'other_id',q,'other_version',1));
 select id into m from public.feedback_merges where source_id in(p,q) and target_id in(p,q) and undone_at is null;
 if m is null then raise exception 'Merge missing'; end if;
 perform public.feedback_write('unmerge',jsonb_build_object('id',m,'version',(select version from public.feedback_posts where id=(select target_id from public.feedback_merges where id=m))));
 if not exists(select 1 from public.feedback_merges where id=m and undone_at is not null) then raise exception 'Unmerge missing'; end if;
 if not exists(select 1 from public.feedback_audit where post_id in(p,q)) then raise exception 'Audit missing'; end if;
 perform set_config('request.jwt.claim.sub','',true);
 r:=public.feedback_read();
 if r->'viewer'->>'can_manage'<>'false' then raise exception 'Anonymous admin projection'; end if;
end $$;
select 'PASS: target RPC create/read/vote/comment/admin/merge/unmerge; all writes rolled back' as result;
rollback;
