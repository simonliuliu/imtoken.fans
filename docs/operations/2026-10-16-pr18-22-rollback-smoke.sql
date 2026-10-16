-- Real target role/RPC smoke, all writes roll back. No account/role changes.
begin;
set local statement_timeout='45s';
do $$ declare a uuid; b uuid; begin
 select id into a from profiles p where (muted_until is null or muted_until<now()) and not exists(select 1 from user_tags where user_id=p.id and tag_key='blacklisted') order by created_at limit 1;
 select id into b from profiles p where id<>a and (muted_until is null or muted_until<now()) and not exists(select 1 from user_tags where user_id=p.id and tag_key='blacklisted') order by created_at limit 1;
 if a is null or b is null then raise exception 'Two existing actors required'; end if;
 perform set_config('smoke.actor_a',a::text,true); perform set_config('smoke.actor_b',b::text,true);
end $$;
set local role authenticated;
do $$ declare a uuid:=current_setting('smoke.actor_a')::uuid; b uuid:=current_setting('smoke.actor_b')::uuid; p uuid:=gen_random_uuid(); q uuid:=gen_random_uuid(); n uuid; v_count bigint; r jsonb; denied boolean:=false; begin
 perform set_config('request.jwt.claim.sub',a::text,true);
 perform follow_write(a,b,true,true,true);
 r:=follow_read(b,a);
 if (r->'subscription'->>'posts')::boolean is not true then raise exception 'Follow preference missing'; end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 perform feedback_write('create',jsonb_build_object('id',p,'title','Transactional following smoke','description','Rollback only, no lasting content','module','wallet'));
 perform feedback_write('create',jsonb_build_object('id',p,'title','Transactional following smoke','description','Rollback only, no lasting content','module','wallet'));
 perform set_config('request.jwt.claim.sub',a::text,true);
 r:=notification_read(a,0);
 select (x->>'id')::uuid into n from jsonb_array_elements(r->'items') x where x->>'submission_title'='Transactional following smoke';
 if n is null then raise exception 'New public event notification missing'; end if;
 if (select count(*) from jsonb_array_elements(r->'items') x where x->>'submission_title'='Transactional following smoke')<>1 then raise exception 'Duplicate notification'; end if;
 perform notification_write(a,'read',n);
 r:=notification_read(a,0);
 if not exists(select 1 from jsonb_array_elements(r->'items') x where x->>'id'=n::text and x->>'read_at' is not null) then raise exception 'Mark read failed'; end if;
 begin perform notification_read(b,0); exception when others then if sqlerrm like '%notification_session%' then denied:=true; else raise; end if; end;
 if not denied then raise exception 'Cross-account read accepted'; end if;
 perform follow_write(a,b,false,true,true);
 perform set_config('request.jwt.claim.sub',b::text,true);
 perform feedback_write('create',jsonb_build_object('id',q,'title','Unfollowed rollback smoke','description','Rollback only, no lasting content','module','wallet'));
 perform set_config('request.jwt.claim.sub',a::text,true);
 r:=notification_read(a,0);
 if exists(select 1 from jsonb_array_elements(r->'items') x where x->>'submission_title'='Unfollowed rollback smoke') then raise exception 'Unfollow still notified'; end if;
 denied:=false;
 begin
 insert into submissions(type,title,tagline,description,status,submitted_by) values('idea','Rollback idea','Rollback idea','Rollback only','pending',a);
 exception when insufficient_privilege then denied:=true; end;
 if not denied then raise exception 'Legacy idea insert accepted'; end if;
 insert into submissions(type,title,tagline,description,status,submitted_by) values('product','Rollback product','Rollback product','Rollback only','pending',a);
 denied:=false;
 begin select count(*) into v_count from notifications; exception when insufficient_privilege then denied:=true; end;
 if not denied then raise exception 'Raw notification table readable'; end if;
end $$;
reset role;
select 'PASS: target authenticated role follow/event/dedup/read/unfollow/identity/product policy; rollback only' as result;
rollback;
