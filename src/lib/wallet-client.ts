// 浏览器端的钱包登录流程：连接钱包（注入式 / WalletConnect 扫码）→ 拿到挑战文案 → 签名 → 服务端校验。
// 两种连接方式最终都是拿到一个 EIP-1193 风格的 provider（有 .request() 方法），后面的挑战/签名/校验逻辑是共用的。

/**
 * 钱包流程里要给用户看的那几句话。
 * 这个文件是普通模块（不是组件），拿不到 useTranslations，所以由调用方（登录页）
 * 把当前语言的文案传进来——见 src/app/[locale]/auth/sign-in/page.tsx。
 */
export interface WalletMessages {
  noInjectedWallet: string;
  noAddress: string;
  noAddressShort: string;
  walletConnectUnavailable: string;
  nonceFailed: string;
  verifyFailed: string;
  metadataDescription: string;
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

export function hasWalletConnectProjectId(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_REOWN_PROJECT_ID);
}

async function requestChallengeAndVerify(
  provider: Eip1193Provider,
  address: string,
  messages: WalletMessages
): Promise<{ address: string }> {
  // /api/* 不走 next-intl 的中间件（见 src/proxy.ts），服务端拿不到 URL 上的语言，
  // 所以显式把 locale 带上；签名挑战文案也要按这个语言生成，校验时才拼得出同一段文字。
  const locale = document.documentElement.lang || "zh";
  const nonceRes = await fetch("/api/auth/wallet/nonce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, locale }),
  });
  const nonceBody = await nonceRes.json();
  if (!nonceRes.ok) {
    throw new Error(nonceBody.error ?? messages.nonceFailed);
  }

  const signature = (await provider.request({
    method: "personal_sign",
    params: [nonceBody.message, address],
  })) as string;

  const verifyRes = await fetch("/api/auth/wallet/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signature, locale }),
  });
  const verifyBody = await verifyRes.json();
  if (!verifyRes.ok) {
    throw new Error(verifyBody.error ?? messages.verifyFailed);
  }

  return { address };
}

export async function connectWalletAndSignIn(messages: WalletMessages): Promise<{ address: string }> {
  const ethereum = window.ethereum;
  if (!ethereum) {
    throw new Error(messages.noInjectedWallet);
  }

  const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts[0];
  if (!address) {
    throw new Error(messages.noAddress);
  }

  return requestChallengeAndVerify(ethereum, address, messages);
}

export async function connectWalletConnectAndSignIn(
  messages: WalletMessages
): Promise<{ address: string }> {
  const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;
  if (!projectId) {
    throw new Error(messages.walletConnectUnavailable);
  }

  // 用动态 import：只有真的点了「扫码连接」才会加载 WalletConnect 的代码，不影响其它页面的体积。
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId,
    chains: [1],
    showQrModal: true,
    metadata: {
      name: "imToken Fans",
      description: messages.metadataDescription,
      url: window.location.origin,
      icons: [`${window.location.origin}/icon`],
    },
  });

  try {
    await provider.connect();
    const address = provider.accounts[0];
    if (!address) {
      throw new Error(messages.noAddressShort);
    }
    return await requestChallengeAndVerify(provider as unknown as Eip1193Provider, address, messages);
  } finally {
    try {
      await provider.disconnect();
    } catch {
      // 断开连接失败不影响登录结果，忽略即可
    }
  }
}
