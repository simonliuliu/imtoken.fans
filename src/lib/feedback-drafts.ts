/** Browser-only login handoff. Drafts are account-scoped and consumed once. */
const MAX_AGE_MS = 30 * 60 * 1000;
const key = (kind: string, owner: string | null) => `imtoken-feedback-draft:${owner ?? "anonymous"}:${kind}`;
export function saveFeedbackDraft<T>(kind: string, owner: string | null, value: T): void {
  sessionStorage.setItem(key(kind, owner), JSON.stringify({ owner, createdAt: Date.now(), value }));
}
export function takeFeedbackDraft<T>(kind: string, owner: string | null, claimAnonymous = false): T | null {
  const ownKey = key(kind, owner);
  let storedKey = ownKey;
  let raw = sessionStorage.getItem(ownKey);
  let expectedOwner = owner;
  if (!raw && owner && claimAnonymous) { storedKey = key(kind, null); raw = sessionStorage.getItem(storedKey); expectedOwner = null; }
  if (!raw) return null;
  const stored = JSON.parse(raw);
  sessionStorage.removeItem(storedKey);
  if (stored.owner !== expectedOwner || typeof stored.createdAt !== "number" || Date.now() - stored.createdAt > MAX_AGE_MS || stored.createdAt > Date.now()) return null;
  return stored.value as T;
}
export function clearFeedbackDraft(kind: string, owner: string | null): void { sessionStorage.removeItem(key(kind, owner)); }
