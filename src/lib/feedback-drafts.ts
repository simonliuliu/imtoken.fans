/** Browser-only login handoff. Drafts are account-scoped and consumed once. */
const MAX_AGE_MS = 30 * 60 * 1000;
const key = (kind: string, owner: string | null) => `imtoken-feedback-draft:${owner ?? "anonymous"}:${kind}`;
export function saveFeedbackDraft<T>(kind: string, owner: string | null, value: T, options?: { retainUntilResolved?: boolean }): void {
  sessionStorage.setItem(key(kind, owner), JSON.stringify({ owner, createdAt: Date.now(), value, retainUntilResolved: options?.retainUntilResolved === true }));
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

/** Persistent reads for editors; legacy takeFeedbackDraft consumers remain one-shot. */
export function readFeedbackDraft<T>(kind: string, owner: string | null, retainLegacy?: (value: T) => boolean): T | null {
  const storedKey = key(kind, owner);
  const raw = sessionStorage.getItem(storedKey);
  if (!raw) return null;
  let stored;
  try { stored = JSON.parse(raw); } catch { sessionStorage.removeItem(storedKey); throw new Error("Invalid draft"); }
  if (!stored || stored.owner !== owner || typeof stored.createdAt !== "number" || !Number.isFinite(stored.createdAt)) {
    sessionStorage.removeItem(storedKey); throw new Error("Invalid draft");
  }
  if (stored.createdAt > Date.now() || (Date.now() - stored.createdAt > MAX_AGE_MS && stored.retainUntilResolved !== true && !retainLegacy?.(stored.value))) { sessionStorage.removeItem(storedKey); return null; }
  return stored.value as T;
}
