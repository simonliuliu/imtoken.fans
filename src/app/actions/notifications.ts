"use server";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";

export async function mutateNotifications(expectedUserId: string, action: "read" | "all" | "clear", id?: string): Promise<{ error?: string }> {
  const t = await getTranslations("notifications");
  try {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user || user.id !== expectedUserId) return { error: t("sessionError") };
    const { error } = await client.rpc("notification_write", { p_expected_user_id: expectedUserId, p_action: action, p_id: id ?? null });
    return error ? { error: t("loadError") } : {};
  } catch { return { error: t("loadError") }; }
}
