// Presentation only: the same toolbar shapes used by the original imAihunt comments.
// Keeping these separate avoids importing live comment Actions into demo threads.
export function CommentToolbarIcon({ name }: { name: "upvote" | "reply" | "report" | "share" | "clock" }) {
  const paths = {
    upvote: <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="m8 14.5 4-5 4 5" /></>,
    reply: <><rect x="3" y="4" width="18" height="14" rx="5" /><path d="m8 21 3-3m2-7H9m0 0 1.8-1.8M9 11l1.8 1.8" /></>,
    report: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></>,
    share: <><path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6m-2-6-4-4-4 4m4-4v12" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
