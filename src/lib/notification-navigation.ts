const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const comment = `(?:#comment-${uuid})?`;
const routes = [
  new RegExp(`^/(?:products|ideas)/${uuid}${comment}$`, "i"),
  new RegExp(`^/community/feedback\\?category=wallet&idea=${uuid}(?:&commentOffset=[0-9]+)?${comment}$`, "i"),
  new RegExp(`^/community/(?:safety|feedback|discussion|activities)/(?:${uuid}|[a-z0-9]+(?:-[a-z0-9]+)*)${comment}$`, "i"),
];
// Only internal route shapes emitted by notification_read, including the real
// community posts introduced in 0030. Reject encoded paths and arbitrary URLs.
export function safeNotificationHref(href?: string | null): string | null {
  return href && href.trim() === href && routes.some((route) => route.test(href)) ? href : null;
}
