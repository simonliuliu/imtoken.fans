import { walletConnectSessionAllowsSignIn } from "@/lib/walletconnect-session";

type SessionConfig = Record<string, unknown>;

export interface WalletConnectSessionStore {
  get(topic: string): unknown;
  update(topic: string, value: { sessionConfig: SessionConfig }): Promise<void>;
}

export interface WalletConnectDeepLinkGuardOptions {
  topic: string;
  address: string;
  challenge: string;
  getBinding(): {
    provider: object;
    client: object;
    store: WalletConnectSessionStore;
    providerSession: unknown;
    chainId: number;
    account: string;
  };
  isCurrent(): boolean;
}

/** The caller must translate this error without exposing SDK internals. */
export class WalletConnectDeepLinkGuardError extends Error {
  constructor() {
    super();
    this.name = "WalletConnectDeepLinkGuardError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

function synchronous<T>(value: T): T {
  if (promiseLike(value)) {
    void Promise.resolve(value).catch(() => {});
    throw new WalletConnectDeepLinkGuardError();
  }
  return value;
}

function sessionIdentity(value: unknown, topic: string, address: string) {
  if (!record(value) || value.topic !== topic || !walletConnectSessionAllowsSignIn(value, address)) {
    throw new WalletConnectDeepLinkGuardError();
  }
  if (!record(value.self) || !record(value.peer) || typeof value.controller !== "string" ||
      typeof value.self.publicKey !== "string" || typeof value.peer.publicKey !== "string" ||
      !value.controller || !value.self.publicKey || !value.peer.publicKey || value.controller !== value.peer.publicKey) {
    throw new WalletConnectDeepLinkGuardError();
  }
  const namespaces = boundedFingerprint(value.namespaces, 4096, 262144, 12);
  return [value.controller, value.self.publicKey, value.peer.publicKey, String(value.expiry), namespaces];
}

function sameIdentity(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function currentConfig(value: unknown): SessionConfig {
  if (!record(value)) throw new WalletConnectDeepLinkGuardError();
  const config = value.sessionConfig;
  if (config === undefined) return {};
  if (!record(config)) throw new WalletConnectDeepLinkGuardError();
  if (Object.getOwnPropertySymbols(config).length || Object.values(Object.getOwnPropertyDescriptors(config)).some((entry) => !entry.enumerable || !("value" in entry))) {
    throw new WalletConnectDeepLinkGuardError();
  }
  return { ...config };
}

// SDK data is JSON-shaped. Bound comparisons and reject exotic values rather
// than retaining references that could be mutated during an await.
function boundedFingerprint(root: unknown, maxNodes: number, maxCharacters: number, maxDepth: number): string {
  let nodes = 0;
  let characters = 0;
  const seen = new Set<object>();
  function encode(value: unknown, depth: number): string {
    nodes++;
    if (nodes > maxNodes || depth > maxDepth) throw new WalletConnectDeepLinkGuardError();
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new WalletConnectDeepLinkGuardError();
      return `number:${Object.is(value, -0) ? "-0" : value}`;
    }
    if (typeof value === "string") {
      characters += value.length;
      if (characters > maxCharacters) throw new WalletConnectDeepLinkGuardError();
      return `string:${JSON.stringify(value)}`;
    }
    synchronous(value);
    if (typeof value !== "object" || seen.has(value)) throw new WalletConnectDeepLinkGuardError();
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 256 || Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) {
          throw new WalletConnectDeepLinkGuardError();
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Object.keys(descriptors).length !== value.length + 1) throw new WalletConnectDeepLinkGuardError();
        return `array:[${Array.from({ length: value.length }, (_item, index) => {
          const entry = descriptors[String(index)];
          if (!entry || !("value" in entry) || !entry.enumerable) throw new WalletConnectDeepLinkGuardError();
          return encode(entry.value, depth + 1);
        }).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null || Object.getOwnPropertySymbols(value).length) {
        throw new WalletConnectDeepLinkGuardError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).sort();
      if (keys.length > 256) throw new WalletConnectDeepLinkGuardError();
      return `object:{${keys.map((key) => {
        const entry = descriptors[key];
        if (!entry.enumerable || !("value" in entry)) throw new WalletConnectDeepLinkGuardError();
        characters += key.length;
        if (characters > maxCharacters) throw new WalletConnectDeepLinkGuardError();
        return `${JSON.stringify(key)}:${encode(entry.value, depth + 1)}`;
      }).join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }
  return encode(root, 0);
}

function configFingerprint(config: SessionConfig): string {
  const rest = { ...config };
  delete rest.disableDeepLink;
  return boundedFingerprint(rest, 256, 32768, 8);
}

/**
 * Prepare one approved session before starting its signature request. The
 * caller must hold the shared wallet lock and pass the selected provider's
 * request method. This wrapper issues one personal_sign request; verification
 * and navigation must happen only after the caller rechecks its own attempt.
 *
 * The SDK reads this local setting from its session store, not from the
 * provider's session object. This does not change the wallet's negotiated
 * configuration and cannot affect an SDK request already in flight. Other
 * code that mutates the SDK store after this check is outside this guard.
 * The binding must expose the provider's actual current chain and account.
 */
export async function withWalletConnectDeepLinkDisabled(
  options: WalletConnectDeepLinkGuardOptions,
  requestSignature: (request: { method: "personal_sign"; params: [string, string] }) => Promise<unknown>
): Promise<string> {
  let topic: string;
  let address: string;
  let challenge: string;
  let getBinding: WalletConnectDeepLinkGuardOptions["getBinding"];
  let isCurrent: WalletConnectDeepLinkGuardOptions["isCurrent"];
  try {
    ({ topic, address, challenge, getBinding, isCurrent } = options);
    if (typeof topic !== "string" || !topic || typeof address !== "string" ||
        typeof challenge !== "string" || !challenge || typeof getBinding !== "function" ||
        typeof isCurrent !== "function" || typeof requestSignature !== "function") {
      throw new WalletConnectDeepLinkGuardError();
    }
  } catch {
    throw new WalletConnectDeepLinkGuardError();
  }

  function requireCurrent() {
    try {
      const unchanged = () => options.topic === topic && options.address === address && options.challenge === challenge &&
        options.getBinding === getBinding && options.isCurrent === isCurrent;
      if (!unchanged()) throw new WalletConnectDeepLinkGuardError();
      const active: unknown = isCurrent.call(options);
      if (active === true && unchanged()) return;
      // A mistakenly asynchronous predicate is invalid; consume its rejection.
      void Promise.resolve(active).catch(() => {});
    } catch {
      // Invalid lifecycle state must fail closed.
    }
    throw new WalletConnectDeepLinkGuardError();
  }

  function readSessions(expectedBinding?: { provider: object; client: object; store: WalletConnectSessionStore }, expected?: string[]) {
    const binding = synchronous(getBinding.call(options));
    if (!record(binding)) throw new WalletConnectDeepLinkGuardError();
    const provider = synchronous(binding.provider);
    const client = synchronous(binding.client);
    const store = synchronous(binding.store);
    const chainId = synchronous(binding.chainId);
    const account = synchronous(binding.account);
    if (!record(provider) || !record(client) || !record(store) ||
        typeof store.get !== "function" || typeof store.update !== "function" ||
        chainId !== 1 || typeof account !== "string" || account.toLowerCase() !== address.toLowerCase() ||
        (expectedBinding && (provider !== expectedBinding.provider || client !== expectedBinding.client || store !== expectedBinding.store))) {
      throw new WalletConnectDeepLinkGuardError();
    }
    const normalized = { provider, client, store };
    const stored = synchronous(store.get(topic));
    const providerSession = synchronous(binding.providerSession);
    const storedIdentity = sessionIdentity(stored, topic, address);
    const providerIdentity = sessionIdentity(providerSession, topic, address);
    if (!sameIdentity(storedIdentity, providerIdentity) || (expected && !sameIdentity(storedIdentity, expected))) {
      throw new WalletConnectDeepLinkGuardError();
    }
    return { binding: normalized, stored, identity: storedIdentity };
  }

  function requireConfig(value: unknown, original: string) {
    const current = currentConfig(value);
    if (current.disableDeepLink !== true) throw new WalletConnectDeepLinkGuardError();
    if (configFingerprint(current) !== original) throw new WalletConnectDeepLinkGuardError();
  }

  try {
    requireCurrent();
    const before = readSessions();
    const config = currentConfig(before.stored);
    if (config.disableDeepLink !== undefined && typeof config.disableDeepLink !== "boolean") throw new WalletConnectDeepLinkGuardError();
    const originalConfig = configFingerprint(config);
    requireCurrent();
    if (config.disableDeepLink !== true) {
      const update = before.binding.store.update(topic, { sessionConfig: { ...config, disableDeepLink: true } });
      if (!promiseLike(update)) throw new WalletConnectDeepLinkGuardError();
      await update;
    }
    requireCurrent();
    const prepared = readSessions(before.binding, before.identity);
    requireConfig(prepared.stored, originalConfig);
    requireCurrent();
    const pending = requestSignature({ method: "personal_sign", params: [challenge, address] });
    if (!promiseLike(pending)) throw new WalletConnectDeepLinkGuardError();
    const signature = await pending;
    if (typeof signature !== "string" || !signature) throw new WalletConnectDeepLinkGuardError();
    requireCurrent();
    const after = readSessions(before.binding, before.identity);
    requireConfig(after.stored, originalConfig);
    requireCurrent();
    return signature;
  } catch {
    throw new WalletConnectDeepLinkGuardError();
  }
}
