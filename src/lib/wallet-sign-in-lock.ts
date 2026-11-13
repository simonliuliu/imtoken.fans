const LOCK_NAME = "imtoken-fans-wallet-sign-in";
let activeInThisTab = false;

/** Serialize wallet sign-in while its shared nonce cookie may be in use. */
export async function withWalletSignInLock<T>(
  messages: { inProgress: string; unavailable: string },
  operation: () => Promise<T>
): Promise<T> {
  if (activeInThisTab) throw new Error(messages.inProgress);
  activeInThisTab = true;

  try {
    let requestLock: LockManager["request"] | undefined;
    try {
      const lockManager = typeof navigator === "undefined" ? undefined : navigator.locks;
      const request = lockManager?.request;
      if (lockManager && typeof request === "function") {
        requestLock = request.bind(lockManager) as LockManager["request"];
      }
    } catch {
      throw new Error(messages.unavailable);
    }

    // Without Web Locks, only this module instance is protected.
    if (!requestLock) return await operation();

    let callbackStarted = false;
    try {
      const result = await requestLock(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        callbackStarted = true;
        if (!lock) throw new Error(messages.inProgress);
        return await operation();
      });
      if (!callbackStarted) throw new Error(messages.unavailable);
      return result;
    } catch (error) {
      if (!callbackStarted) throw new Error(messages.unavailable);
      throw error;
    }
  } finally {
    activeInThisTab = false;
  }
}
