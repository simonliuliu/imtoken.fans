import { safeJsonStringify } from "@walletconnect/safe-json";
import { destr } from "destr";
import type { WalletConnectKeyValueStorage, WalletConnectScopedStorage } from "@/lib/walletconnect-scoped-storage";

const VALUE_NAMESPACE = "imtoken-fans:walletconnect-value:v1:";

function valueKey(key: string): string {
  if (typeof key !== "string") throw new TypeError("Invalid WalletConnect storage key");
  return VALUE_NAMESPACE + key;
}

/**
 * Match the value encoding used by WalletConnect's 1.1.1 browser IndexedDB
 * backend, while retaining the scoped view's retirement behavior. The scoped
 * view deliberately preserves distinct logical keys rather than reproducing
 * unstorage's key-normalization aliases. Encoded values use their own versioned
 * namespace; callers must use a fresh scope rather than reusing raw-value scopes.
 */
export function walletConnectValueStorage(scope: WalletConnectScopedStorage): WalletConnectKeyValueStorage {
  return {
    async getKeys() {
      const keys = await scope.getKeys();
      if (scope.closed) return [];
      return keys.filter((key) => key.startsWith(VALUE_NAMESPACE)).map((key) => key.slice(VALUE_NAMESPACE.length));
    },
    async getEntries<T = unknown>() {
      const keys = await scope.getKeys();
      if (scope.closed) return [];
      const entries: [string, T][] = [];
      for (const key of keys) {
        if (!key.startsWith(VALUE_NAMESPACE)) continue;
        const raw = await scope.getItem(key);
        if (scope.closed) return [];
        // The default backend's getEntries preserves null values, unlike getItem.
        entries.push([key.slice(VALUE_NAMESPACE.length), destr(raw ?? null) as T]);
      }
      return scope.closed ? [] : entries;
    },
    async getItem<T = unknown>(key: string) {
      if (scope.closed) return undefined;
      const raw = await scope.getItem(valueKey(key));
      if (scope.closed) return undefined;
      const value = destr(raw ?? null);
      return value === null ? undefined : value as T | undefined;
    },
    async setItem<T = unknown>(key: string, value: T) {
      if (scope.closed) return;
      let encoded: string;
      try {
        encoded = safeJsonStringify(value);
      } catch (error) {
        // A reentrant toJSON can retire the scope before it throws.
        if (scope.closed) return;
        throw error;
      }
      // A user-supplied toJSON may synchronously retire the scope.
      if (scope.closed) return;
      await scope.setItem(valueKey(key), encoded);
    },
    async removeItem(key: string) {
      if (scope.closed) return;
      await scope.removeItem(valueKey(key));
    },
  };
}
