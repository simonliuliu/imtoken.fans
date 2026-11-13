import type { WalletConnectScopedStorage } from "@/lib/walletconnect-scoped-storage";

/**
 * An isolated, in-memory SDK view for one wallet attempt. It deliberately
 * does not restore a session after the document is destroyed. Values retain
 * JavaScript reference semantics; this is not a clone of the SDK's IndexedDB
 * encoding, an access-control boundary, or a way to erase all copies.
 *
 * Retiring the view clears its own map and makes later SDK calls inert. A
 * value already returned to a caller cannot be revoked: the caller must still
 * guard authentication, navigation, and cleanup using the attempt lifecycle.
 */
export function createWalletConnectEphemeralStorage(): WalletConnectScopedStorage {
  const entries = new Map<string, unknown>();
  let closed = false;

  return {
    get closed() { return closed; },
    async getKeys() {
      return closed ? [] : [...entries.keys()];
    },
    async getEntries<T = unknown>() {
      return closed ? [] : [...entries.entries()] as [string, T][];
    },
    async getItem<T = unknown>(key: string) {
      return closed ? undefined : entries.get(key) as T | undefined;
    },
    async setItem<T = unknown>(key: string, value: T) {
      if (!closed) entries.set(key, value);
    },
    async removeItem(key: string) {
      if (!closed) entries.delete(key);
    },
    async close() {
      if (!closed) {
        closed = true;
        entries.clear();
      }
    },
  };
}
