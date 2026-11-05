import { createClient } from "@/lib/supabase/server";
import type { UserTagKey } from "@/lib/types";

// user_tags 是公开可读的（RLS: select using (true)），走普通客户端读就行。
export async function getUserTagsMap(userIds: string[]): Promise<Record<string, UserTagKey[]>> {
  if (userIds.length === 0) return {};
  const supabase = await createClient();
  const { data } = await supabase.from("user_tags").select("user_id, tag_key").in("user_id", userIds);

  const map: Record<string, UserTagKey[]> = {};
  for (const row of data ?? []) {
    const list = map[row.user_id] ?? [];
    list.push(row.tag_key as UserTagKey);
    map[row.user_id] = list;
  }
  return map;
}

// null means the restriction could not be checked, not that the user is allowed.
export async function isBlacklisted(userId: string): Promise<boolean | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("user_tags")
      .select("tag_key")
      .eq("user_id", userId)
      .eq("tag_key", "blacklisted")
      .maybeSingle();
    if (error || data === undefined) return null;
    return data !== null;
  } catch {
    return null;
  }
}
