// Shared non-secret policy for the local provisioning script and server-only login route.
export const LOCAL_DEV_ORIGINS = ["http://localhost:4000", "http://127.0.0.1:4000"] as const;
export const LOCAL_DEV_ACCOUNTS = [
  { key: "userA", userId: "da000000-0000-4000-a000-000000000001", email: "local.dev.a@example.test", username: "local_dev_a", role: "user", name: "Local Dev A" },
  { key: "userB", userId: "da000000-0000-4000-a000-000000000002", email: "local.dev.b@example.test", username: "local_dev_b", role: "user", name: "Local Dev B" },
  { key: "admin", userId: "da000000-0000-4000-a000-000000000003", email: "local.dev.admin@example.test", username: "local_dev_admin", role: "admin", name: "Local Dev Admin" },
] as const;

export type LocalDevAccountKey = (typeof LOCAL_DEV_ACCOUNTS)[number]["key"];

type Environment = Readonly<Record<string, string | undefined>>;

export function isLocalDevAuthConfigured(env: Environment): boolean {
  return env.NODE_ENV === "development" && env.LOCAL_DEV_AUTH_ENABLED === "true" &&
    env.NEXT_PUBLIC_SUPABASE_URL === "http://127.0.0.1:54321" &&
    LOCAL_DEV_ORIGINS.some(origin => origin === env.NEXT_PUBLIC_SITE_URL);
}

export function isLocalDevAuthRequestAllowed(
  env: Environment,
  request: { host: string | null; origin: string | null },
  requireOrigin: boolean,
): boolean {
  if (!isLocalDevAuthConfigured(env)) return false;
  const origin = `http://${request.host}`;
  if (!LOCAL_DEV_ORIGINS.some(allowed => origin === allowed)) return false;
  return request.origin === null ? !requireOrigin : request.origin === origin;
}

export function localDevAccount(key: unknown) {
  return LOCAL_DEV_ACCOUNTS.find(account => account.key === key);
}
