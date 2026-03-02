import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk";
import { getFluxerRuntime } from "./runtime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FluxerBindingRecord = {
  bindingId: string;
  accountId: string;
  conversationId: string;
  targetSessionKey: string;
  targetKind: "session" | "subagent";
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  expiresAt?: number;
};

export type FluxerBindingManagerOpts = {
  accountId: string;
  ttlMs?: number;
  sweepIntervalMs?: number;
  storePath?: string;
};

export type FluxerBindingManager = {
  accountId: string;

  bind(params: {
    conversationId: string;
    targetSessionKey: string;
    targetKind: "session" | "subagent";
    agentId?: string;
    label?: string;
    boundBy?: string;
    ttlMs?: number;
  }): FluxerBindingRecord;

  unbindByConversation(conversationId: string): FluxerBindingRecord | null;
  unbindBySessionKey(targetSessionKey: string): FluxerBindingRecord[];

  resolveByConversation(conversationId: string): FluxerBindingRecord | null;
  listBySessionKey(targetSessionKey: string): FluxerBindingRecord[];
  listBindings(): FluxerBindingRecord[];

  touch(conversationId: string): void;
  sweep(): void;
  stop(): void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let bindingCounter = 0;

function generateBindingId(accountId: string): string {
  return `fluxer:${accountId}:${Date.now().toString(36)}:${(++bindingCounter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Binding Manager Factory
// ---------------------------------------------------------------------------

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export function createFluxerBindingManager(
  opts: FluxerBindingManagerOpts,
): FluxerBindingManager {
  const { accountId, sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS } = opts;
  const defaultTtlMs = opts.ttlMs ?? 0;

  const bindings = new Map<string, FluxerBindingRecord>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  function schedulePersist() {
    if (persistTimer) return;
    dirty = true;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistBindings().catch(() => {});
    }, 2000);
  }

  async function persistBindings() {
    const storePath = resolveStorePath();
    if (!storePath) return;
    const records = Array.from(bindings.values());
    try {
      await writeJsonFileAtomically(storePath, records);
      dirty = false;
    } catch {
      // Persistence is best-effort
    }
  }

  function resolveStorePath(): string | null {
    if (opts.storePath) return opts.storePath;
    try {
      const runtime = getFluxerRuntime();
      const stateDir = runtime.state.resolveStateDir();
      return `${stateDir}/fluxer-bindings-${accountId}.json`;
    } catch {
      return null;
    }
  }

  async function loadBindings() {
    const storePath = resolveStorePath();
    if (!storePath) return;
    try {
      const { value, exists } = await readJsonFileWithFallback<FluxerBindingRecord[]>(
        storePath,
        [],
      );
      if (!exists || !Array.isArray(value)) return;
      const now = Date.now();
      for (const record of value) {
        if (record.expiresAt && record.expiresAt <= now) continue;
        if (record.conversationId && record.targetSessionKey) {
          bindings.set(record.conversationId, record);
        }
      }
    } catch {
      // Load failure is non-fatal
    }
  }

  function sweepExpired() {
    const now = Date.now();
    let swept = false;
    for (const [key, record] of bindings) {
      if (record.expiresAt && record.expiresAt <= now) {
        bindings.delete(key);
        swept = true;
      }
    }
    if (swept) schedulePersist();
  }

  // Start sweep timer
  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(sweepExpired, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  // Load persisted bindings
  loadBindings().catch(() => {});

  const manager: FluxerBindingManager = {
    accountId,

    bind(params) {
      const existing = bindings.get(params.conversationId);
      if (existing && existing.targetSessionKey === params.targetSessionKey) {
        existing.boundAt = Date.now();
        if (params.ttlMs || defaultTtlMs) {
          existing.expiresAt = Date.now() + (params.ttlMs ?? defaultTtlMs);
        }
        schedulePersist();
        return existing;
      }

      const record: FluxerBindingRecord = {
        bindingId: generateBindingId(accountId),
        accountId,
        conversationId: params.conversationId,
        targetSessionKey: params.targetSessionKey,
        targetKind: params.targetKind,
        agentId: params.agentId,
        label: params.label,
        boundBy: params.boundBy,
        boundAt: Date.now(),
        expiresAt:
          params.ttlMs || defaultTtlMs
            ? Date.now() + (params.ttlMs ?? defaultTtlMs)
            : undefined,
      };

      bindings.set(params.conversationId, record);
      schedulePersist();
      return record;
    },

    unbindByConversation(conversationId) {
      const record = bindings.get(conversationId);
      if (!record) return null;
      bindings.delete(conversationId);
      schedulePersist();
      return record;
    },

    unbindBySessionKey(targetSessionKey) {
      const removed: FluxerBindingRecord[] = [];
      for (const [key, record] of bindings) {
        if (record.targetSessionKey === targetSessionKey) {
          bindings.delete(key);
          removed.push(record);
        }
      }
      if (removed.length > 0) schedulePersist();
      return removed;
    },

    resolveByConversation(conversationId) {
      const record = bindings.get(conversationId);
      if (!record) return null;
      if (record.expiresAt && record.expiresAt <= Date.now()) {
        bindings.delete(conversationId);
        schedulePersist();
        return null;
      }
      return record;
    },

    listBySessionKey(targetSessionKey) {
      const now = Date.now();
      const result: FluxerBindingRecord[] = [];
      for (const record of bindings.values()) {
        if (record.targetSessionKey !== targetSessionKey) continue;
        if (record.expiresAt && record.expiresAt <= now) continue;
        result.push(record);
      }
      return result;
    },

    listBindings() {
      const now = Date.now();
      return Array.from(bindings.values()).filter(
        (r) => !r.expiresAt || r.expiresAt > now,
      );
    },

    touch(conversationId) {
      const record = bindings.get(conversationId);
      if (!record) return;
      if (record.expiresAt && defaultTtlMs) {
        record.expiresAt = Date.now() + defaultTtlMs;
        schedulePersist();
      }
    },

    sweep: sweepExpired,

    stop() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (dirty) {
        persistBindings().catch(() => {});
      }
    },
  };

  return manager;
}

// ---------------------------------------------------------------------------
// Per-account manager registry
// ---------------------------------------------------------------------------

const managers = new Map<string, FluxerBindingManager>();

export function getOrCreateBindingManager(
  opts: FluxerBindingManagerOpts,
): FluxerBindingManager {
  const existing = managers.get(opts.accountId);
  if (existing) return existing;
  const manager = createFluxerBindingManager(opts);
  managers.set(opts.accountId, manager);
  return manager;
}

export function getBindingManager(accountId: string): FluxerBindingManager | undefined {
  return managers.get(accountId);
}

export function stopAllBindingManagers(): void {
  for (const manager of managers.values()) {
    manager.stop();
  }
  managers.clear();
}

// ---------------------------------------------------------------------------
// Global session binding adapter registration (best-effort)
// ---------------------------------------------------------------------------

/**
 * Attempt to register a Fluxer session binding adapter with the global
 * SessionBindingService. These functions are not yet exported from
 * openclaw/plugin-sdk, so registration is best-effort: if the import
 * fails, we still function via the local binding manager that the
 * monitor queries directly.
 */
export async function tryRegisterSessionBindingAdapter(
  manager: FluxerBindingManager,
): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = await import("openclaw/plugin-sdk");
    const register = (sdk as Record<string, unknown>)[
      "registerSessionBindingAdapter"
    ] as
      | ((adapter: Record<string, unknown>) => void)
      | undefined;
    if (typeof register !== "function") return false;

    register({
      channel: "fluxer",
      accountId: manager.accountId,
      capabilities: { placements: ["current"] },

      listBySession: (targetSessionKey: string) =>
        manager.listBySessionKey(targetSessionKey).map(toAdapterRecord),

      resolveByConversation: (ref: { conversationId: string }) => {
        const record = manager.resolveByConversation(ref.conversationId);
        return record ? toAdapterRecord(record) : null;
      },

      touch: (bindingId: string) => {
        const record = manager
          .listBindings()
          .find((r) => r.bindingId === bindingId);
        if (record) manager.touch(record.conversationId);
      },

      unbind: async (input: {
        bindingId?: string;
        targetSessionKey?: string;
      }) => {
        if (input.targetSessionKey) {
          return manager
            .unbindBySessionKey(input.targetSessionKey)
            .map(toAdapterRecord);
        }
        if (input.bindingId) {
          const record = manager
            .listBindings()
            .find((r) => r.bindingId === input.bindingId);
          if (record) {
            const removed = manager.unbindByConversation(
              record.conversationId,
            );
            return removed ? [toAdapterRecord(removed)] : [];
          }
        }
        return [];
      },
    });
    return true;
  } catch {
    return false;
  }
}

function toAdapterRecord(record: FluxerBindingRecord) {
  return {
    bindingId: record.bindingId,
    targetSessionKey: record.targetSessionKey,
    targetKind: record.targetKind,
    conversation: {
      channel: "fluxer",
      accountId: record.accountId,
      conversationId: record.conversationId,
    },
    status: "active" as const,
    boundAt: record.boundAt,
    expiresAt: record.expiresAt,
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
    },
  };
}
