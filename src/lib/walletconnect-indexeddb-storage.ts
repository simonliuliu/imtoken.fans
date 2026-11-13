import type { WalletConnectKeyValueStorage } from "@/lib/walletconnect-scoped-storage";

// Separate from the SDK's default database and localStorage migration. This
// backend does not read, migrate, or delete existing WalletConnect records.
const DATABASE_NAME = "imtoken-fans-walletconnect-attempts";
const DATABASE_VERSION = 1;
const STORE_NAME = "attempts";

/** A browser-only backend for scoped WalletConnect attempts. */
export function createWalletConnectAttemptStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB
): WalletConnectKeyValueStorage {
  if (!factory) throw new Error("IndexedDB is unavailable");
  let connection: Promise<IDBDatabase> | undefined;
  let liveDatabase: IDBDatabase | undefined;

  function forget(database: IDBDatabase) {
    if (liveDatabase === database) {
      liveDatabase = undefined;
      connection = undefined;
    }
  }

  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    let abandoned = false;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onblocked = () => {
        abandoned = true;
        reject(new Error("WalletConnect storage is blocked"));
      };
      request.onupgradeneeded = () => {
        if (abandoned) {
          request.transaction?.abort();
          return;
        }
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      };
      request.onerror = () => reject(request.error ?? new Error("WalletConnect storage could not be opened"));
      request.onsuccess = () => {
        const database = request.result;
        if (abandoned) {
          database.close();
          return;
        }
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.close();
          reject(new Error("WalletConnect storage schema is invalid"));
          return;
        }
        liveDatabase = database;
        database.onversionchange = () => {
          database.close();
          forget(database);
        };
        database.onclose = () => forget(database);
        resolve(database);
      };
    });
    connection = pending.catch((error) => {
      connection = undefined;
      throw error;
    });
    return connection;
  }

  async function transact<T>(
    mode: IDBTransactionMode,
    requestOperation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const database = await open();
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE_NAME, mode);
      } catch (error) {
        if (error && typeof error === "object" && "name" in error && error.name === "InvalidStateError") {
          database.close();
          forget(database);
        }
        reject(error);
        return;
      }
      let result: T;
      let completedRequest = false;
      let requestError: DOMException | null = null;
      let hasSynchronousError = false;
      let synchronousError: unknown;
      transaction.onabort = () => reject(hasSynchronousError ? synchronousError : transaction.error ?? requestError ?? new Error("WalletConnect storage transaction aborted"));
      transaction.oncomplete = () => {
        if (hasSynchronousError) {
          reject(synchronousError);
        } else if (!completedRequest) {
          reject(requestError ?? new Error("WalletConnect storage request did not complete"));
        } else {
          resolve(result);
        }
      };
      let request: IDBRequest<T>;
      try {
        request = requestOperation(transaction.objectStore(STORE_NAME));
      } catch (error) {
        hasSynchronousError = true;
        synchronousError = error;
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
        return;
      }
      request.onsuccess = () => {
        result = request.result;
        completedRequest = true;
      };
      request.onerror = () => { requestError = request.error; };
    });
  }

  const storage: WalletConnectKeyValueStorage = {
    async getKeys() {
      const keys = await transact("readonly", (store) => store.getAllKeys());
      if (keys.some((key) => typeof key !== "string")) throw new Error("WalletConnect storage contains an invalid key");
      return keys as string[];
    },
    async getEntries<T = unknown>() {
      const keys = await storage.getKeys();
      const entries: [string, T][] = [];
      for (const key of keys) {
        const value = await storage.getItem<T>(key);
        if (value !== undefined) entries.push([key, value]);
      }
      return entries;
    },
    async getItem<T = unknown>(key: string) {
      const value = await transact("readonly", (store) => store.get(key));
      return value as T | undefined;
    },
    async setItem<T = unknown>(key: string, value: T) {
      await transact("readwrite", (store) => store.put(value, key));
    },
    async removeItem(key: string) {
      await transact("readwrite", (store) => store.delete(key));
    },
  };
  return storage;
}
