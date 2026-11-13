import { createWalletConnectEphemeralStorage } from "@/lib/walletconnect-ephemeral-storage";
import { createWalletConnectStorageScope, type WalletConnectKeyValueStorage, type WalletConnectScopedStorage } from "@/lib/walletconnect-scoped-storage";
import { walletConnectValueStorage } from "@/lib/walletconnect-storage-codec";
import type { WalletConnectAttemptContext, WalletConnectOwnedAttempt } from "@/lib/walletconnect-attempt-coordinator";
import { sha256 } from "viem";

/** The narrow SDK surface used by this unconnected resource owner. */
export interface WalletConnectAttemptCore {
  storage: WalletConnectKeyValueStorage;
  customStoragePrefix: string;
  heartbeat: { stop(): void };
  relayer: { transportClose(): Promise<void>; subscriber: { isKnownTopic(topic: string): Promise<boolean> } };
  crypto: { keychain: { has(key: string): boolean; get(key: string): unknown } };
  expirer: { has(topic: string): boolean };
}

export interface WalletConnectAttemptProvider {
  client: { core: WalletConnectAttemptCore; session: { getAll(): unknown[] }; pairing: { getAll(): unknown[] } };
  session?: unknown;
  on(event: "display_uri", listener: (uri: unknown) => void): void;
  removeListener(event: "display_uri", listener: (uri: unknown) => void): void;
  disconnect(): Promise<void>;
  cleanupPendingPairings(options: { deletePairings: true }): Promise<void>;
}

export class WalletConnectOwnerFailed extends Error {
  constructor() { super(); this.name = "WalletConnectOwnerFailed"; }
}

export class WalletConnectOwnerCleanupFailed extends Error {
  constructor() { super(); this.name = "WalletConnectOwnerCleanupFailed"; }
}

const LOCAL_RESOURCES_PENDING = Symbol("walletconnect-local-resources-pending");
const SDK_IDENTIFIER = /^[a-f0-9]{64}$/;

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

function rejectAsync(value: unknown): boolean {
  if (!promiseLike(value)) return false;
  void Promise.resolve(value).catch(() => {});
  return true;
}

function consumeThrown(value: unknown): void {
  try { rejectAsync(value); } catch { /* Invalid thenable; remain failed. */ }
}

function requirePromise<T>(value: Promise<T>): PromiseLike<T> {
  if (!promiseLike(value)) throw new WalletConnectOwnerFailed();
  return value;
}

function topic(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (rejectAsync(value)) throw new WalletConnectOwnerCleanupFailed();
  if (typeof value !== "object" || Array.isArray(value)) throw new WalletConnectOwnerCleanupFailed();
  const result = (value as { topic?: unknown }).topic;
  if (rejectAsync(result)) throw new WalletConnectOwnerCleanupFailed();
  if (typeof result !== "string" || !SDK_IDENTIFIER.test(result)) throw new WalletConnectOwnerCleanupFailed();
  return result;
}

function sessionIdentity(value: unknown): { topic: string; selfKey: string; pairingTopic: string } | undefined {
  const sessionTopic = topic(value);
  if (sessionTopic === undefined) return undefined;
  const session = value as { self?: unknown; pairingTopic?: unknown };
  const self = session.self;
  if (rejectAsync(self) || typeof self !== "object" || self === null || Array.isArray(self)) throw new WalletConnectOwnerCleanupFailed();
  const selfKey = (self as { publicKey?: unknown }).publicKey;
  const invalidSelfKey = rejectAsync(selfKey);
  const pairingTopic = session.pairingTopic;
  const invalidPairingTopic = rejectAsync(pairingTopic);
  if (invalidSelfKey || invalidPairingTopic || typeof selfKey !== "string" || !SDK_IDENTIFIER.test(selfKey) ||
      typeof pairingTopic !== "string" || !SDK_IDENTIFIER.test(pairingTopic)) throw new WalletConnectOwnerCleanupFailed();
  return { topic: sessionTopic, selfKey, pairingTopic };
}

/**
 * Construct an inert owner before any SDK work. Core construction and SDK
 * initialization happen once inside run(). The caller must use the shared
 * attempt coordinator and wallet lock, validate the actual approved session,
 * and guard nonce, signature, verification and navigation independently.
 * A successful close records only the operations below, not complete SDK,
 * remote pairing, background-task or key-material destruction.
 */
export function createWalletConnectAttemptOwner<T>(options: {
  createCore(storage: WalletConnectKeyValueStorage, uniquePrefix: string): WalletConnectAttemptCore;
  createProvider(core: WalletConnectAttemptCore): Promise<WalletConnectAttemptProvider>;
  connect(provider: WalletConnectAttemptProvider): Promise<unknown>;
  onUri(uri: string): unknown;
  onConnected(provider: WalletConnectAttemptProvider, session: unknown, context: WalletConnectAttemptContext): Promise<T>;
}): WalletConnectOwnedAttempt<T> {
  let started = false;
  let running = false;
  let closing = false;
  let closeComplete = false;
  let closePending: Promise<void> | undefined;
  let storage: WalletConnectScopedStorage | undefined;
  let view: WalletConnectKeyValueStorage | undefined;
  let expectedPrefix: string | undefined;
  let core: WalletConnectAttemptCore | undefined;
  let provider: WalletConnectAttemptProvider | undefined;
  let uncertainOwnership = false;
  let untrackedWork = false;
  let listener: ((uri: unknown) => void) | undefined;
  let listenerMayBeAttached = false;
  let disconnectStarted = false;
  let disconnectResolved = false;
  let capturedSession: ReturnType<typeof sessionIdentity>;
  const capturedPairings = new Set<string>();
  let disconnectComplete = false;
  let pairingsRequested = false;
  let heartbeatStopped = false;
  let transportClosed = false;
  let storageClosed = false;

  function rememberPairing(value: string): void {
    if (!capturedPairings.has(value) && capturedPairings.size >= 256) {
      uncertainOwnership = true;
      throw new WalletConnectOwnerCleanupFailed();
    }
    capturedPairings.add(value);
  }

  function tracked<T>(start: () => Promise<T>): PromiseLike<T> {
    try {
      const pending = start();
      if (!promiseLike(pending)) throw new WalletConnectOwnerFailed();
      return pending;
    } catch (error) {
      consumeThrown(error);
      // A contract violation may have started work without returning a handle.
      untrackedWork = true;
      throw new WalletConnectOwnerFailed();
    }
  }

  function ownedCore(): boolean {
    try {
      if (!core || !view) return false;
      const actual: unknown = core.storage;
      const invalidStorage = rejectAsync(actual);
      const prefix: unknown = core.customStoragePrefix;
      const invalidPrefix = rejectAsync(prefix);
      return !invalidStorage && !invalidPrefix && actual === view && prefix === expectedPrefix;
    } catch (error) { consumeThrown(error); return false; }
  }

  function ownedProvider(): boolean {
    try {
      if (!provider || !core || !ownedCore()) return false;
      const actual: unknown = provider.client.core;
      return !rejectAsync(actual) && actual === core;
    } catch (error) { consumeThrown(error); return false; }
  }

  function recheckOwnership(): void {
    if ((core && !ownedCore()) || (provider && !ownedProvider())) {
      uncertainOwnership = true;
      throw new WalletConnectOwnerCleanupFailed();
    }
  }

  function currentSession(): ReturnType<typeof sessionIdentity> {
    if (!provider || !ownedProvider()) {
      uncertainOwnership = true;
      throw new WalletConnectOwnerCleanupFailed();
    }
    const current = sessionIdentity(provider.session);
    const entries = provider.client.session.getAll();
    if (rejectAsync(entries)) throw new WalletConnectOwnerCleanupFailed();
    if (!Array.isArray(entries) || entries.length > 1) throw new WalletConnectOwnerCleanupFailed();
    const stored = entries.length ? sessionIdentity(entries[0]) : undefined;
    if (stored?.topic !== current?.topic || stored?.selfKey !== current?.selfKey ||
        stored?.pairingTopic !== current?.pairingTopic) throw new WalletConnectOwnerCleanupFailed();
    return current;
  }

  function pairingTopics(): string[] {
    if (!provider || !ownedProvider()) {
      uncertainOwnership = true;
      throw new WalletConnectOwnerCleanupFailed();
    }
    const entries = provider.client.pairing.getAll();
    if (rejectAsync(entries) || !Array.isArray(entries) || entries.length > 256) throw new WalletConnectOwnerCleanupFailed();
    const values = entries.map((entry) => {
      const value = topic(entry);
      if (!value) throw new WalletConnectOwnerCleanupFailed();
      return value;
    });
    if (new Set(values).size !== values.length) throw new WalletConnectOwnerCleanupFailed();
    return values;
  }

  // This deliberately accepts only the three-parameter shape generated by
  // the currently tested SDK. Future URI variants must be reviewed before
  // they can reach a QR renderer. A URI contains its pairing encryption key.
  function validateOwnedPairingUri(uri: string, expectedTopic: string): void {
    if (!provider || !core || !ownedProvider()) throw new WalletConnectOwnerFailed();
    if (/[^\x21-\x7e]/.test(uri)) throw new WalletConnectOwnerFailed();
    const query = uri.slice(uri.indexOf("?") + 1).split("&");
    if (query.length !== 3) throw new WalletConnectOwnerFailed();
    const params = new Map<string, string>();
    for (const part of query) {
      const match = /^(expiryTimestamp|relay-protocol|symKey)=([A-Za-z0-9]+)$/.exec(part);
      if (!match || params.has(match[1])) throw new WalletConnectOwnerFailed();
      params.set(match[1], match[2]);
    }
    const key = params.get("symKey");
    const expiryText = params.get("expiryTimestamp");
    if (!key || !SDK_IDENTIFIER.test(key) || !expiryText || !/^[1-9][0-9]{0,10}$/.test(expiryText) ||
        params.get("relay-protocol") !== "irn") throw new WalletConnectOwnerFailed();
    const expires = Number(expiryText);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expires) || expires <= now || expires > now + 600) throw new WalletConnectOwnerFailed();
    if (sha256(`0x${key}`).slice(2) !== expectedTopic) throw new WalletConnectOwnerFailed();
    const validatePairing = () => {
      const entries = provider!.client.pairing.getAll();
      if (rejectAsync(entries) || !Array.isArray(entries) || entries.length > 256) throw new WalletConnectOwnerFailed();
      const matching = entries.filter((entry) => topic(entry) === expectedTopic);
      if (matching.length !== 1) throw new WalletConnectOwnerFailed();
      const pairing = matching[0] as { expiry?: unknown; active?: unknown; methods?: unknown; relay?: unknown };
      const pairingExpiry = pairing.expiry;
      const invalidExpiry = rejectAsync(pairingExpiry);
      const active = pairing.active;
      const invalidActive = rejectAsync(active);
      const methods = pairing.methods;
      const invalidMethods = rejectAsync(methods);
      const relay = pairing.relay;
      const invalidRelay = rejectAsync(relay);
      if (invalidExpiry || invalidActive || invalidMethods || invalidRelay ||
          typeof relay !== "object" || relay === null || Array.isArray(relay)) throw new WalletConnectOwnerFailed();
      const relayFields = relay as { protocol?: unknown; data?: unknown };
      const protocol = relayFields.protocol;
      const invalidProtocol = rejectAsync(protocol);
      const data = relayFields.data;
      const invalidData = rejectAsync(data);
      if (invalidProtocol || invalidData || pairingExpiry !== expires || active !== false || methods !== undefined ||
          protocol !== "irn" || (data !== undefined && data !== "")) throw new WalletConnectOwnerFailed();
    };
    validatePairing();
    const storedKey = core.crypto.keychain.get(expectedTopic);
    if (rejectAsync(storedKey) || storedKey !== key) throw new WalletConnectOwnerFailed();
    recheckOwnership();
    validatePairing();
  }

  async function assertLocalResourcesGone(): Promise<void> {
    if (!core || !ownedCore() || !ownedProvider()) {
      uncertainOwnership = true;
      throw new WalletConnectOwnerCleanupFailed();
    }
    const sessionKeys = capturedSession ? [capturedSession.topic, capturedSession.selfKey] : [];
    const topics = new Set([...capturedPairings, ...(capturedSession ? [capturedSession.topic] : [])]);
    for (const key of new Set([...sessionKeys, ...capturedPairings])) {
      const present: unknown = core.crypto.keychain.has(key);
      if (rejectAsync(present) || typeof present !== "boolean") throw new WalletConnectOwnerCleanupFailed();
      if (present) throw LOCAL_RESOURCES_PENDING;
    }
    for (const key of topics) {
      const expires: unknown = core.expirer.has(key);
      if (rejectAsync(expires) || typeof expires !== "boolean") throw new WalletConnectOwnerCleanupFailed();
      if (expires) throw LOCAL_RESOURCES_PENDING;
      const known = await requirePromise(core.relayer.subscriber.isKnownTopic(key));
      if (!ownedCore() || !ownedProvider()) {
        uncertainOwnership = true;
        throw new WalletConnectOwnerCleanupFailed();
      }
      if (typeof known !== "boolean") throw new WalletConnectOwnerCleanupFailed();
      if (known) throw LOCAL_RESOURCES_PENDING;
    }
    if (currentSession() !== undefined) throw new WalletConnectOwnerCleanupFailed();
    if (pairingTopics().length !== 0) throw LOCAL_RESOURCES_PENDING;
  }

  async function waitForLocalResources(): Promise<void> {
    for (let index = 0; index < 40; index++) {
      try {
        if (pairingTopics().length !== 0) throw LOCAL_RESOURCES_PENDING;
        await assertLocalResourcesGone();
        return;
      } catch (error) {
        if (error !== LOCAL_RESOURCES_PENDING || index === 39) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async function cleanup(): Promise<void> {
    if (running) throw new WalletConnectOwnerCleanupFailed();
    closing = true;
    if (untrackedWork) throw new WalletConnectOwnerCleanupFailed();
    if (provider && !ownedProvider()) uncertainOwnership = true;
    if (core && !ownedCore()) uncertainOwnership = true;

    if (provider && ownedProvider()) {
      if (listenerMayBeAttached && listener) {
        const removed: unknown = provider.removeListener("display_uri", listener);
        if (rejectAsync(removed)) { untrackedWork = true; throw new WalletConnectOwnerCleanupFailed(); }
        listenerMayBeAttached = false;
      }
      const before = currentSession();
      if (before && capturedSession && (before.topic !== capturedSession.topic || before.selfKey !== capturedSession.selfKey ||
          before.pairingTopic !== capturedSession.pairingTopic)) throw new WalletConnectOwnerCleanupFailed();
      if (before) {
        capturedSession = before;
        rememberPairing(before.pairingTopic);
      }
      for (const value of pairingTopics()) rememberPairing(value);
      if (!disconnectComplete) {
        if (disconnectResolved) {
          if (before !== undefined) throw new WalletConnectOwnerCleanupFailed();
          disconnectComplete = true;
        } else if (before === undefined) {
          // A rejected disconnect may have deleted the session but failed
          // later cleanup; its outcome cannot be inferred from absence alone.
          if (disconnectStarted) throw new WalletConnectOwnerCleanupFailed();
          disconnectComplete = true;
        } else {
          disconnectStarted = true;
          await tracked(() => provider!.disconnect());
          recheckOwnership();
          disconnectResolved = true;
          if (currentSession() !== undefined) throw new WalletConnectOwnerCleanupFailed();
          disconnectComplete = true;
        }
      }
      if (!pairingsRequested) {
        if (!ownedProvider()) throw new WalletConnectOwnerCleanupFailed();
        await tracked(() => provider!.cleanupPendingPairings({ deletePairings: true }));
        recheckOwnership();
        pairingsRequested = true;
      }
      await waitForLocalResources();
    }

    if (core && ownedCore()) {
      if (!heartbeatStopped) {
        const stopped: unknown = core.heartbeat.stop();
        if (rejectAsync(stopped)) { untrackedWork = true; throw new WalletConnectOwnerCleanupFailed(); }
        recheckOwnership();
        heartbeatStopped = true;
      }
      if (!transportClosed) {
        if (!ownedCore()) throw new WalletConnectOwnerCleanupFailed();
        try { await tracked(() => core!.relayer.transportClose()); recheckOwnership(); } catch (error) { heartbeatStopped = false; throw error; }
        transportClosed = true;
      }
    }
    if (storage && !storageClosed) {
      try { await tracked(() => storage!.close()); recheckOwnership(); } catch (error) {
        heartbeatStopped = false;
        transportClosed = false;
        throw error;
      }
      storageClosed = true;
    }
    recheckOwnership();
    if (uncertainOwnership || untrackedWork) throw new WalletConnectOwnerCleanupFailed();
  }

  return {
    async run(context) {
      if (started || closing) throw new WalletConnectOwnerFailed();
      started = true;
      running = true;
      try {
        context.assertActive();
        // Read the caller's renderer before starting SDK work. A getter or an
        // asynchronous value must not execute for the first time after the
        // pairing has been validated.
        let onUri: unknown;
        try { onUri = options.onUri; } catch (error) {
          consumeThrown(error);
          throw new WalletConnectOwnerFailed();
        }
        if (rejectAsync(onUri) || typeof onUri !== "function") throw new WalletConnectOwnerFailed();
        context.assertActive();
        const uniquePrefix = `imtoken-fans-${createWalletConnectStorageScope()}`;
        expectedPrefix = `:${uniquePrefix}`;
        storage = createWalletConnectEphemeralStorage();
        view = walletConnectValueStorage(storage);
        context.assertActive();
        uncertainOwnership = true;
        const nextCore = options.createCore(view, uniquePrefix);
        if (promiseLike(nextCore)) {
          void Promise.resolve(nextCore).catch(() => {});
          throw new WalletConnectOwnerFailed();
        }
        core = nextCore;
        if (!ownedCore()) throw new WalletConnectOwnerFailed();
        uncertainOwnership = false;
        context.assertActive();
        uncertainOwnership = true;
        const nextProvider = await requirePromise(options.createProvider(core));
        provider = nextProvider;
        if (!ownedProvider()) throw new WalletConnectOwnerFailed();
        uncertainOwnership = false;
        context.assertActive();
        listener = (uri) => {
          if (rejectAsync(uri) || typeof uri !== "string" || uri.length > 4096) {
            uncertainOwnership = true;
            context.publish(() => { throw new WalletConnectOwnerFailed(); });
            return;
          }
          // Capture only the pairing topic for cleanup; never retain the URI.
          const match = /^wc:([a-f0-9]{64})@2\?/.exec(uri);
          if (!match) {
            uncertainOwnership = true;
            context.publish(() => { throw new WalletConnectOwnerFailed(); });
            return;
          }
          try { rememberPairing(match[1]); } catch {
            context.publish(() => { throw new WalletConnectOwnerFailed(); });
            return;
          }
          context.publish(() => {
            context.assertActive();
            try {
              validateOwnedPairingUri(uri, match[1]);
            } catch (error) {
              consumeThrown(error);
              uncertainOwnership = true;
              throw new WalletConnectOwnerFailed();
            }
            context.assertActive();
            try {
              validateOwnedPairingUri(uri, match[1]);
            } catch (error) {
              consumeThrown(error);
              uncertainOwnership = true;
              throw new WalletConnectOwnerFailed();
            }
            context.assertActive();
            try {
              recheckOwnership();
            } catch (error) {
              consumeThrown(error);
              uncertainOwnership = true;
              throw new WalletConnectOwnerFailed();
            }
            return onUri.call(options, uri);
          });
        };
        listenerMayBeAttached = true;
        const added: unknown = provider.on("display_uri", listener);
        if (rejectAsync(added)) { untrackedWork = true; throw new WalletConnectOwnerFailed(); }
        recheckOwnership();
        context.assertActive();
        const session = await tracked(() => options.connect(provider!));
        const returned = sessionIdentity(session);
        if (returned) {
          capturedSession = returned;
          rememberPairing(returned.pairingTopic);
        }
        const connected = currentSession();
        if (!connected || !returned || connected.topic !== returned.topic || connected.selfKey !== returned.selfKey ||
            connected.pairingTopic !== returned.pairingTopic) throw new WalletConnectOwnerFailed();
        capturedSession = connected;
        rememberPairing(connected.pairingTopic);
        for (const value of pairingTopics()) rememberPairing(value);
        context.assertActive();
        const value = await tracked(() => options.onConnected(provider!, session, context));
        recheckOwnership();
        context.assertActive();
        return value;
      } catch (error) {
        consumeThrown(error);
        throw new WalletConnectOwnerFailed();
      } finally {
        running = false;
      }
    },
    close() {
      if (closeComplete) return Promise.resolve();
      if (!closePending) {
        closePending = cleanup().then(() => { closeComplete = true; }, (error) => { consumeThrown(error); throw new WalletConnectOwnerCleanupFailed(); })
          .finally(() => { closePending = undefined; });
      }
      return closePending;
    },
  };
}
