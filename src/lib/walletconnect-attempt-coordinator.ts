/**
 * A local lifecycle barrier for a future WalletConnect implementation.
 * This does not replace the shared wallet sign-in lock, stop the SDK, revoke
 * a request already sent, or coordinate different documents or modules.
 */
export type WalletConnectAttemptState = "running" | "cleaning" | "cleanup-failed" | "ownership-failed" | "finished";

export interface WalletConnectAttemptContext {
  /** Check before and after each asynchronous authentication operation. */
  assertActive(): void;
  /** Only synchronous UI callbacks may be delivered through this boundary. */
  publish(callback: () => unknown): boolean;
}

export interface WalletConnectOwnedAttempt<T> {
  run(context: WalletConnectAttemptContext): Promise<T>;
  /** Must be safe to retry after failure; resolve only after owned cleanup. */
  close(): Promise<void>;
}

export interface WalletConnectAttemptHandle<T> {
  readonly result: Promise<T>;
  /** Await in the wallet lock's finally block, even when result rejects. */
  readonly released: Promise<void>;
  readonly state: WalletConnectAttemptState;
  /** Retire only this attempt. It does not interrupt an SDK operation. */
  cancel(): boolean;
  /** Retry this attempt's failed cleanup; a failed result is never restored. */
  retryCleanup(): Promise<void>;
}

export class WalletConnectAttemptBusy extends Error {
  constructor() { super(); this.name = "WalletConnectAttemptBusy"; }
}

export class WalletConnectAttemptCancelled extends Error {
  constructor() { super(); this.name = "WalletConnectAttemptCancelled"; }
}

export class WalletConnectAttemptFailed extends Error {
  constructor() { super(); this.name = "WalletConnectAttemptFailed"; }
}

export class WalletConnectAttemptCleanupFailed extends Error {
  constructor() { super(); this.name = "WalletConnectAttemptCleanupFailed"; }
}

export class WalletConnectAttemptOwnershipFailed extends Error {
  constructor() { super(); this.name = "WalletConnectAttemptOwnershipFailed"; }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

function rejectAsyncValue(value: unknown): boolean {
  if (!isPromiseLike(value)) return false;
  void Promise.resolve(value).catch(() => {});
  return true;
}

function consumeThrown(value: unknown): void {
  try { rejectAsyncValue(value); } catch { /* Invalid thenable; remain failed. */ }
}

/**
 * The factory must synchronously return an owner before starting SDK work.
 * If ownership cannot be obtained, this coordinator remains blocked because
 * it cannot know which side effects need cleanup. It deliberately offers no
 * unsafe "forget" operation. A successful close only means the owner's close
 * contract completed, not that all internal SDK resources were stopped.
 */
export function createWalletConnectAttemptCoordinator() {
  type Lease = { state: WalletConnectAttemptState; retired: boolean; close?: () => Promise<void> };
  let active: Lease | undefined;

  function start<T>(options: {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    create(): WalletConnectOwnedAttempt<T>;
  }): WalletConnectAttemptHandle<T> {
    if (active) throw new WalletConnectAttemptBusy();
    const lease: Lease = { state: "running", retired: false };
    active = lease;
    let signalReleased: () => void = () => {};
    const released = new Promise<void>((resolve) => { signalReleased = resolve; });
    let signal: AbortSignal | undefined;
    let isCurrent: (() => boolean) | undefined;
    let create: () => WalletConnectOwnedAttempt<T>;
    try {
      // Consume each accessed promise immediately; a later getter may throw.
      let asynchronous = rejectAsyncValue(options);
      signal = options.signal;
      asynchronous = rejectAsyncValue(signal) || asynchronous;
      isCurrent = options.isCurrent;
      asynchronous = rejectAsyncValue(isCurrent) || asynchronous;
      create = options.create;
      asynchronous = rejectAsyncValue(create) || asynchronous;
      if (asynchronous ||
          typeof create !== "function" || (isCurrent !== undefined && typeof isCurrent !== "function")) {
        throw new Error();
      }
    } catch (error) {
      consumeThrown(error);
      active = undefined;
      lease.state = "finished";
      throw new WalletConnectAttemptFailed();
    }

    function current(allowCleanup = false): boolean {
      const phaseAllowed = () => lease.state === "running" || (allowCleanup && lease.state === "cleaning");
      const signalIsActive = () => {
        if (signal === undefined) return true;
        const aborted: unknown = signal.aborted;
        if (aborted === false) return true;
        rejectAsyncValue(aborted);
        return false;
      };
      if (active !== lease || lease.retired || !phaseAllowed()) return false;
      try {
        if (!signalIsActive()) throw new Error();
        if (isCurrent) {
          const value: unknown = isCurrent();
          if (value !== true) {
            rejectAsyncValue(value);
            throw new Error();
          }
        }
        if (active !== lease || lease.retired || !phaseAllowed() || !signalIsActive()) throw new Error();
        return true;
      } catch (error) {
        consumeThrown(error);
        lease.retired = true;
        return false;
      }
    }

    const context: WalletConnectAttemptContext = {
      assertActive() { if (!current()) throw new WalletConnectAttemptCancelled(); },
      publish(callback) {
        if (!current()) return false;
        try {
          if (typeof callback !== "function" || rejectAsyncValue(callback())) throw new Error();
          return current();
        } catch (error) {
          consumeThrown(error);
          lease.retired = true;
          return false;
        }
      },
    };

    async function closeOwned(): Promise<void> {
      lease.state = "cleaning";
      try {
        const pending = lease.close?.();
        if (!isPromiseLike(pending)) throw new Error();
        await pending;
      } catch (error) {
        consumeThrown(error);
        lease.state = "cleanup-failed";
        throw new WalletConnectAttemptCleanupFailed();
      }
    }

    function release() {
      if (active === lease) active = undefined;
      lease.state = "finished";
      signalReleased();
    }

    const result = (async () => {
      let startedFactory = false;
      let value: T | undefined;
      let failed = false;
      try {
        context.assertActive();
        startedFactory = true;
        const owner: unknown = create.call(options);
        if (rejectAsyncValue(owner) || typeof owner !== "object" || owner === null) throw new Error();
        const candidate = owner as WalletConnectOwnedAttempt<T>;
        const close = candidate.close;
        if (rejectAsyncValue(close) || typeof close !== "function") throw new Error();
        lease.close = () => close.call(candidate);
        const run = candidate.run;
        if (rejectAsyncValue(run) || typeof run !== "function") throw new Error();
        context.assertActive();
        const pending = run.call(candidate, context);
        if (!isPromiseLike(pending)) throw new Error();
        value = await pending;
        context.assertActive();
      } catch (error) {
        consumeThrown(error);
        failed = true;
      }

      if (!lease.close) {
        if (startedFactory) {
          lease.retired = true;
          lease.state = "ownership-failed";
          throw new WalletConnectAttemptOwnershipFailed();
        }
        release();
        throw new WalletConnectAttemptCancelled();
      }

      await closeOwned();
      const stillCurrent = current(true);
      release();
      if (!stillCurrent) throw new WalletConnectAttemptCancelled();
      if (failed) throw new WalletConnectAttemptFailed();
      return value as T;
    })();

    return {
      result,
      released,
      get state() { return lease.state; },
      cancel() {
        if (active !== lease || lease.retired) return false;
        lease.retired = true;
        return true;
      },
      async retryCleanup() {
        if (active !== lease || lease.state !== "cleanup-failed" || !lease.close) throw new WalletConnectAttemptCleanupFailed();
        await closeOwned();
        release();
      },
    };
  }

  return { start };
}

/** Use one module instance together with the existing shared wallet lock. */
export const walletConnectAttemptCoordinator = createWalletConnectAttemptCoordinator();
