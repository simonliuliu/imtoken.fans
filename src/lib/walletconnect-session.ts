import { isAddress } from "viem";

const MAX_SESSION_ACCOUNTS = 256;
const MAX_SESSION_METHODS = 128;
const MAX_SESSION_CHAINS = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check the wallet's approved session, rather than the requested permissions. */
export function walletConnectSessionAllowsSignIn(
  session: unknown,
  selectedAddress: unknown,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (typeof selectedAddress !== "string" || !isAddress(selectedAddress)) return false;
  if (!isRecord(session) || !isRecord(session.namespaces)) return false;
  if (typeof session.expiry !== "number" || !Number.isSafeInteger(session.expiry) || session.expiry <= nowSeconds) return false;

  const approvedAccount = `eip155:1:${selectedAddress}`.toLowerCase();
  for (const key of ["eip155", "eip155:1"]) {
    if (!Object.prototype.hasOwnProperty.call(session.namespaces, key)) continue;
    const namespace = session.namespaces[key];
    if (!isRecord(namespace)) continue;
    if (!Array.isArray(namespace.accounts) || namespace.accounts.length > MAX_SESSION_ACCOUNTS) continue;
    if (!Array.isArray(namespace.methods) || namespace.methods.length > MAX_SESSION_METHODS) continue;
    if (!namespace.methods.includes("personal_sign")) continue;
    if (namespace.chains !== undefined) {
      if (!Array.isArray(namespace.chains) || namespace.chains.length > MAX_SESSION_CHAINS) continue;
      if (!namespace.chains.includes("eip155:1")) continue;
    }
    if (namespace.accounts.some((account) =>
      typeof account === "string" && account.toLowerCase() === approvedAccount
    )) return true;
  }
  return false;
}
