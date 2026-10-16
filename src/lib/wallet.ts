import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

// 钱包登录（SIWE 风格签名验证）用到的挑战码（nonce）签发与校验。
// 挑战码不落库，而是签名后放进一个短期 httpOnly cookie 里，服务端用 HMAC 验证没有被篡改。
export const WALLET_NONCE_COOKIE = "imaihunt_wallet_nonce";
const NONCE_TTL_MS = 5 * 60 * 1000;

function getSecret(): string {
  const secret = process.env.WALLET_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "缺少 WALLET_AUTH_SECRET 环境变量，请先在 .env.local 中配置（用 `openssl rand -base64 32` 生成一个）"
    );
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export interface WalletChallenge {
  address: string;
  nonce: string;
  issuedAt: number;
  /** 签名文案用哪种语言。存进 cookie 里，校验时才能拼出和用户签的那段一模一样的文字 */
  locale?: string;
}

// 钱包弹窗里给用户看的那段文字，跟着界面语言变。
// 注意：/api/auth/wallet/verify 必须用完全一样的 locale 重新拼一次，
// 差一个字签名就验不过——所以 locale 是随 nonce 一起存进 cookie 的，不重新猜。
export function buildChallengeMessage({ address, nonce, issuedAt, locale }: WalletChallenge): string {
  const lines =
    locale === "en"
      ? [
          "imToken Fans wants to verify that you own this wallet",
          "",
          `Address: ${address}`,
          `Nonce: ${nonce}`,
          `Time: ${new Date(issuedAt).toISOString()}`,
          "",
          "This is a gasless signature used only for sign-in. It makes no on-chain transaction or approval.",
        ]
      : [
          "imToken Fans 想要验证你的钱包所有权",
          "",
          `地址：${address}`,
          `随机码：${nonce}`,
          `时间：${new Date(issuedAt).toISOString()}`,
          "",
          "这是一次免 Gas 的签名，仅用于登录验证，不会发起任何链上交易或授权。",
        ];
  return lines.join("\n");
}

export function createChallengeCookieValue(
  address: string,
  locale: string
): {
  cookieValue: string;
  challenge: WalletChallenge;
} {
  const challenge: WalletChallenge = {
    address: address.toLowerCase(),
    nonce: randomBytes(16).toString("hex"),
    issuedAt: Date.now(),
    locale,
  };
  const encoded = Buffer.from(JSON.stringify(challenge)).toString("base64url");
  const signature = sign(encoded);
  return { cookieValue: `${encoded}.${signature}`, challenge };
}

export function verifyChallengeCookieValue(
  cookieValue: string | undefined,
  address: string
): WalletChallenge | null {
  if (!cookieValue) return null;
  const [encoded, signature] = cookieValue.split(".");
  if (!encoded || !signature) return null;

  const expectedSignature = sign(encoded);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) {
    return null;
  }

  let challenge: WalletChallenge;
  try {
    challenge = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return null;
  }

  if (challenge.address !== address.toLowerCase()) return null;
  if (Date.now() - challenge.issuedAt > NONCE_TTL_MS) return null;
  return challenge;
}

export function walletSyntheticEmail(address: string): string {
  return `${address.toLowerCase()}@wallet.imaihunt.internal`;
}
