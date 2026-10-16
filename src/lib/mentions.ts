// @提及解析：字符集和 normalizeUsername 保持一致（src/lib/username.ts），
// 发布评论时用来找通知对象，渲染评论正文时用同一个正则把 @username 转成链接。
//
// 注意：不在这里把用户名统一转小写。username/password 注册的账号确实都是小写
// （normalizeUsername 强制），但 Google 登录（0002_auth_profile_sync.sql 的 handle_new_user）
// 直接拿 full_name 当 username，大小写不受控。转小写去匹配数据库会导致这类账号永远匹配不上，
// 所以保留原始大小写，交给查询层做大小写不敏感匹配（ilike）。
// Do not turn email addresses or the prefix of a longer identifier into mentions.
// Keep the database notification matcher in 0026 aligned with this boundary.
const MENTION_PATTERN = /(?<![a-z0-9_@.])@([a-z0-9_]{3,20})(?![a-z0-9_])/gi;

export function extractMentionedUsernames(body: string): string[] {
  const usernames = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    usernames.add(match[1]);
  }
  return [...usernames];
}

export type CommentBodySegment = { type: "text"; value: string } | { type: "mention"; username: string };

export function splitCommentBodyByMentions(body: string): CommentBodySegment[] {
  const segments: CommentBodySegment[] = [];
  let lastIndex = 0;

  for (const match of body.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ type: "text", value: body.slice(lastIndex, index) });
    segments.push({ type: "mention", username: match[1] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < body.length) segments.push({ type: "text", value: body.slice(lastIndex) });

  return segments;
}
