import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { isAddress, verifyMessage } from "viem";
import { routing } from "@/i18n/routing";
import { buildChallengeMessage, verifyChallengeCookieValue, walletNonceConsumptionKey, walletSyntheticEmail, WALLET_NONCE_COOKIE } from "@/lib/wallet";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";

// 同 nonce 路由：语言由 body 里的 locale 决定（/api/* 不走 next-intl 中间件）。
function pickLocale(raw: unknown): string {
  return typeof raw === "string" && routing.locales.includes(raw as (typeof routing.locales)[number])
    ? raw
    : routing.defaultLocale;
}

export async function POST(request: Request) {
  let body: { address?: unknown; signature?: unknown; locale?: unknown };
  try {
    body = await request.json();
  } catch {
    const t = await getTranslations({ locale: routing.defaultLocale, namespace: "errors" });
    return NextResponse.json({ error: t("badRequest") }, { status: 400 });
  }

  const t = await getTranslations({ locale: pickLocale(body.locale), namespace: "errors" });

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: t("supabaseNotConfiguredSignIn") }, { status: 503 });
  }

  const { address, signature } = body;
  if (typeof address !== "string" || !isAddress(address) || typeof signature !== "string") {
    return NextResponse.json({ error: t("invalidParams") }, { status: 400 });
  }

  const cookieStore = await cookies();
  const raw = cookieStore.get(WALLET_NONCE_COOKIE)?.value;
  cookieStore.delete(WALLET_NONCE_COOKIE);

  let challenge;
  try {
    challenge = verifyChallengeCookieValue(raw, address);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t("nonceVerifyFailed") },
      { status: 500 }
    );
  }
  if (!challenge) {
    return NextResponse.json({ error: t("nonceExpired") }, { status: 400 });
  }

  const message = buildChallengeMessage(challenge);
  const isValidSignature = await verifyMessage({
    address: address as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  });
  if (!isValidSignature) {
    return NextResponse.json({ error: t("signatureInvalid") }, { status: 401 });
  }

  const normalizedAddress = address.toLowerCase();
  const syntheticEmail = walletSyntheticEmail(normalizedAddress);

  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t("adminKeyMissing") },
      { status: 500 }
    );
  }

  // The browser deleting its cookie cannot revoke a copied or in-flight request.
  // Consume the verified nonce atomically before creating users or sessions.
  try {
    const { data: consumed, error } = await admin.rpc("consume_wallet_sign_in_nonce", {
      p_nonce_key: walletNonceConsumptionKey(challenge),
      p_issued_at_ms: challenge.issuedAt,
    });
    if (error || (consumed !== true && consumed !== false)) {
      return NextResponse.json({ error: t("nonceVerifyFailed") }, { status: 503 });
    }
    if (!consumed) {
      return NextResponse.json({ error: t("nonceExpired") }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: t("nonceVerifyFailed") }, { status: 503 });
  }

  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .eq("wallet_address", normalizedAddress)
    .maybeSingle();

  if (!existingProfile) {
    const { error: createError } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      email_confirm: true,
      user_metadata: { wallet_address: normalizedAddress, auth_method: "wallet" },
    });
    if (createError) {
      return NextResponse.json({ error: createError.message }, { status: 500 });
    }
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: syntheticEmail,
  });
  if (linkError || !link) {
    return NextResponse.json({ error: linkError?.message ?? t("tokenCreateFailed") }, { status: 500 });
  }

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "email",
  });
  if (verifyError) {
    return NextResponse.json({ error: verifyError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
