/** The asynchronous key-value interface consumed by WalletConnect. */
export interface WalletConnectKeyValueStorage {
  getKeys(): Promise<string[]>;
  getEntries<T = unknown>(): Promise<[string, T][]>;
  getItem<T = unknown>(key: string): Promise<T | undefined>;
  setItem<T = unknown>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface WalletConnectScopedStorage extends WalletConnectKeyValueStorage {
  /** Retired immediately when close starts, even if cleanup later fails. */
  readonly closed: boolean;
  /** Stop new operations, finish queued ones, and remove only this scope. */
  close(): Promise<void>;
}

const STORAGE_PREFIX = "imtoken-fans:walletconnect-attempt:v1:";
const SCOPE_PATTERN = /^[0-9a-f]{32}$/;

// Encode UTF-16 code units so even empty keys, lone surrogates, separators and
// question marks survive backend key normalization without collisions.
function encodeKey(key: string): string {
  if (typeof key !== "string") throw new TypeError("Invalid WalletConnect storage key");
  let encoded = "";
  for (let index = 0; index < key.length; index++) {
    encoded += key.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function decodeKey(encoded: string): string {
  if (encoded.length % 4 !== 0 || /[^0-9a-f]/.test(encoded)) {
    throw new Error("Invalid encoded WalletConnect storage key");
  }
  let key = "";
  for (let index = 0; index < encoded.length; index += 4) {
    key += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 4), 16));
  }
  return key;
}

/** Use a fresh scope and a matching unique SDK prefix for each attempt. */
export function createWalletConnectStorageScope(): string {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error("Secure random generation is unavailable");
  }
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Present one attempt's keys to the SDK even when attempts share a backend.
 * This prevents broad SDK cleanup from deleting another view's keys. It is
 * not an access-control boundary against code that can use the backend.
 * A retired view silently drops SDK calls, but that does not stop the SDK or
 * cancel authentication: callers must separately reject stale attempts before
 * requesting a challenge, signing, verifying or navigating.
 */
export function scopeWalletConnectStorage(
  backend: WalletConnectKeyValueStorage,
  scope: string
): WalletConnectScopedStorage {
  if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) throw new TypeError("Invalid WalletConnect storage scope");
  // The nonempty k suffix prevents normalizing backends from stripping the
  // final delimiter when the SDK uses an empty logical key.
  const prefix = `${STORAGE_PREFIX}${scope}:k`;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  function enqueue<T>(operation: () => Promise<T>, retiredValue: () => T): Promise<T> {
    // The SDK can issue fire-and-forget storage calls after disconnect. A
    // retired view is inert; callers must independently reject stale attempts.
    if (closed) return Promise.resolve(retiredValue());
    const result = tail.then(async () => {
      if (closed) return retiredValue();
      try {
        const value = await operation();
        return closed ? retiredValue() : value;
      } catch (error) {
        if (closed) return retiredValue();
        throw error;
      }
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    get closed() { return closed; },
    getKeys() {
      return enqueue(async () => (await backend.getKeys()).filter((key) => key.startsWith(prefix)).map((key) => decodeKey(key.slice(prefix.length))), () => []);
    },
    getEntries<T = unknown>() {
      return enqueue(async () => {
        const ownKeys = (await backend.getKeys())
          .filter((key) => key.startsWith(prefix))
          .map((physical) => ({ physical, logical: decodeKey(physical.slice(prefix.length)) }));
        const entries: [string, T][] = [];
        for (const key of ownKeys) {
          const value = await backend.getItem<T>(key.physical);
          if (value !== undefined) entries.push([key.logical, value]);
        }
        return entries;
      }, () => []);
    },
    getItem<T = unknown>(key: string) {
      return enqueue(() => backend.getItem<T>(prefix + encodeKey(key)), () => undefined);
    },
    setItem<T = unknown>(key: string, value: T) {
      return enqueue(() => backend.setItem(prefix + encodeKey(key), value), () => undefined);
    },
    removeItem(key: string) {
      return enqueue(() => backend.removeItem(prefix + encodeKey(key)), () => undefined);
    },
    close() {
      closed = true;
      if (!closePromise) {
        closePromise = tail.then(async () => {
          for (const key of await backend.getKeys()) {
            if (key.startsWith(prefix)) await backend.removeItem(key);
          }
        }).catch((error) => {
          closePromise = undefined;
          throw error;
        });
      }
      return closePromise;
    },
  };
}
