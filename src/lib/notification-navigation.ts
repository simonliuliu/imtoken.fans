const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COMMENT = `(?:#comment-${UUID})?`;
const CONTENT_DETAIL = new RegExp(`^/(?:products|ideas)/${UUID}${COMMENT}$`);
const COMMUNITY_DETAIL = new RegExp(`^/community/(?:safety|discussion|activities|feedback)/[a-z0-9]+(?:-[a-z0-9]+)*${COMMENT}$`);
const FEEDBACK_DETAIL = new RegExp(`^/community/feedback\\?category=wallet&idea=${UUID}(?:&commentOffset=[0-9]+)?${COMMENT}$`);

// notification_read returns locale-free paths. Keep the complete path and comment
// anchor, then let the shared next-intl router add the viewer's current locale.
// Match only supported detail routes; do not normalize or decode untrusted URLs.
export function safeNotificationHref(href?: string | null): string | null {
  if (typeof href !== "string" || !href || /\s/.test(href)) return null;
  return CONTENT_DETAIL.test(href) || COMMUNITY_DETAIL.test(href) || FEEDBACK_DETAIL.test(href) ? href : null;
}
