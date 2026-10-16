"use client";
import { useEffect, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { Link } from "@/i18n/navigation";
import { getSignInHref } from "@/lib/auth-navigation";

type State = { followers: number; following: number; subscription: { posts: boolean; comments: boolean } | null; people: { username: string; name: string }[] };
export function FollowControls({ targetId, username }: { targetId: string; username: string }) {
 const t = useTranslations("following"); const locale=useLocale();
 const { user, sessionEpoch, loading }=useAuth();
 const identity=`${user?.id ?? "anon"}:${sessionEpoch}:${targetId}`;
 const [state,setState]=useState<{identity:string; data?:State; error?:boolean}>({identity:""});
 const [pending,startTransition]=useTransition();
 useEffect(()=>{ let alive=true; const client=createClient();
  Promise.resolve(client.rpc("follow_read",{p_target:targetId,p_expected_user_id:user?.id ?? null})).then(({data,error})=>{if(alive)setState({identity,data:error?undefined:data as State,error:Boolean(error)});}).catch(()=>{if(alive)setState({identity,error:true});});
  return ()=>{alive=false;};
 },[identity,targetId,user?.id]);
 const current=state.identity===identity?state:undefined;
 const data=current?.data;
 function write(follow:boolean,posts=true,comments=true){
  if(!user)return;
  const expected=user.id;
  startTransition(async()=>{
   try { const client=createClient();const {error}=await client.rpc("follow_write",{p_expected_user_id:expected,p_target:targetId,p_follow:follow,p_posts:posts,p_comments:comments});
    if(error){setState(prev=>prev.identity===identity?{...prev,error:true}:prev);return;}
    const result=await client.rpc("follow_read",{p_target:targetId,p_expected_user_id:user?.id ?? null});
    setState(prev=>prev.identity===identity?{identity,data:result.error?undefined:result.data as State,error:Boolean(result.error)}:prev);
   }catch{setState(prev=>prev.identity===identity?{...prev,error:true}:prev);}
  });
 }
 return <div className="mt-5 space-y-3 text-sm">
  {data && <p className="text-muted">{t("counts",{followers:data.followers,following:data.following})}</p>}
  {!loading && user?.id!==targetId && (user ? <button className="rounded-full border border-line px-4 py-2 font-semibold disabled:opacity-50" disabled={pending||!data} onClick={()=>write(!data?.subscription)}>{data?.subscription?t("unfollow"):t("follow")}</button>:<Link className="text-brand-ink underline" href={getSignInHref(`/u/${encodeURIComponent(username)}?follow=1`,locale)}>{t("signIn")}</Link>)}
  {data?.subscription && <fieldset disabled={pending} className="flex flex-wrap gap-4"><legend className="mb-2 text-muted">{t("subscriptions")}</legend><label className="flex gap-2"><input type="checkbox" checked={data.subscription.posts} onChange={e=>write(true,e.target.checked,data.subscription!.comments)}/>{t("posts")}</label><label className="flex gap-2"><input type="checkbox" checked={data.subscription.comments} onChange={e=>write(true,data.subscription!.posts,e.target.checked)}/>{t("comments")}</label></fieldset>}
  {current?.error && <p role="alert" className="text-risk">{t("error")}</p>}
  {data && <details><summary className="cursor-pointer text-muted">{t("list")}</summary><div className="mt-2 flex flex-wrap gap-3">{data.people.length?data.people.map(p=><Link key={p.username} href={`/u/${encodeURIComponent(p.username)}`} className="text-brand-ink">{p.name}</Link>):<p className="text-muted">{t("empty")}</p>}</div></details>}
 </div>;
}
