import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

const memoryStateStore = new Map<string, unknown>();
const persistentWriteQueues = new Map<string, Promise<void>>();

export interface PersistentStateMetadata {
  source: "backend" | "legacy-local-storage" | "memory";
  schemaVersion: number | null;
  recovered: boolean;
  corrupt: boolean;
  quarantined: boolean;
  unsafeLegacyPlaylist: boolean;
  degraded: boolean;
}

export interface LoadedPersistentValue {
  value: unknown | null;
  shouldMigrate: boolean;
  metadata: PersistentStateMetadata;
}

export interface AppStatePayload {
  exists: boolean;
  value: unknown | null;
  schemaVersion?: number | null;
  recovered?: boolean;
  corrupt?: boolean;
  quarantined?: boolean;
  unsafeLegacyPlaylist?: boolean;
}

const cleanBackendMetadata: PersistentStateMetadata = {
  source: "backend",
  schemaVersion: null,
  recovered: false,
  corrupt: false,
  quarantined: false,
  unsafeLegacyPlaylist: false,
  degraded: false,
};

function reviveValue<T>(value: unknown, initialValue: T, reviver?: (val: unknown) => T) {
  if (value === null) {
    return initialValue;
  }

  return reviver ? reviver(value) : (value as T);
}

function loadLegacyLocalStorageValue(key: string): LoadedPersistentValue {
  const metadata: PersistentStateMetadata = {
    ...cleanBackendMetadata,
    source: "legacy-local-storage",
  };

  try {
    const storedValue = window.localStorage.getItem(key);

    if (storedValue === null) {
      return { value: null, shouldMigrate: false, metadata };
    }

    return {
      value: JSON.parse(storedValue),
      shouldMigrate: true,
      metadata,
    };
  } catch {
    return { value: null, shouldMigrate: false, metadata };
  }
}

function isAppStatePayload(value: unknown): value is AppStatePayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "exists" in value &&
    typeof (value as AppStatePayload).exists === "boolean"
  );
}

export function resolvePersistentPayload(
  payload: AppStatePayload,
  legacyValue: LoadedPersistentValue,
): LoadedPersistentValue {
  const metadata: PersistentStateMetadata = {
    source: "backend",
    schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : null,
    recovered: payload.recovered === true,
    corrupt: payload.corrupt === true,
    quarantined: payload.quarantined === true,
    unsafeLegacyPlaylist: payload.unsafeLegacyPlaylist === true,
    degraded:
      payload.recovered === true ||
      payload.corrupt === true ||
      payload.quarantined === true ||
      payload.unsafeLegacyPlaylist === true,
  };

  if (!payload.exists) {
    // A pristine absence may be a first run from before native persistence.
    // Once native storage reports damage/quarantine, stale localStorage must not
    // silently resurrect state that the backend deliberately isolated.
    if (!metadata.corrupt && !metadata.quarantined) {
      return legacyValue;
    }
    return { value: null, shouldMigrate: false, metadata };
  }

  return {
    value: payload.value ?? null,
    shouldMigrate: metadata.schemaVersion === 0 || metadata.unsafeLegacyPlaylist,
    metadata,
  };
}

async function loadPersistentValue(key: string): Promise<LoadedPersistentValue> {
  if (!isTauri()) {
    return {
      value: memoryStateStore.has(key) ? memoryStateStore.get(key) ?? null : null,
      shouldMigrate: false,
      metadata: { ...cleanBackendMetadata, source: "memory" },
    };
  }

  const storedValue = await invoke<AppStatePayload | unknown | null>("load_app_state", { key });

  if (isAppStatePayload(storedValue)) {
    return resolvePersistentPayload(storedValue, loadLegacyLocalStorageValue(key));
  }

  if (storedValue !== null) {
    return {
      value: storedValue,
      shouldMigrate: false,
      metadata: cleanBackendMetadata,
    };
  }

  return loadLegacyLocalStorageValue(key);
}

async function savePersistentValue(key: string, value: unknown) {
  if (!isTauri()) {
    memoryStateStore.set(key, value);
    return;
  }

  await invoke("save_app_state", { key, value });
}

export function enqueuePersistentWrite(key: string, write: () => Promise<void>) {
  const previousWrite = persistentWriteQueues.get(key) ?? Promise.resolve();
  const currentWrite = previousWrite.then(write);
  const queueTail = currentWrite.then(
    () => undefined,
    () => undefined,
  );
  persistentWriteQueues.set(key, queueTail);
  void queueTail.then(() => {
    if (persistentWriteQueues.get(key) === queueTail) {
      persistentWriteQueues.delete(key);
    }
  });
  return currentWrite;
}

export async function persistMigratedValue(
  save: () => Promise<void>,
  removeLegacy: () => void,
) {
  await save();
  removeLegacy();
}

export async function persistPreparedValue<T>(
  value: T,
  beforePersist: ((value: T) => Promise<void>) | undefined,
  serializer: (value: T) => unknown,
  save: (serializedValue: unknown) => Promise<void>,
  removeLegacy?: () => void,
) {
  await beforePersist?.(value);
  const serializedValue = serializer(value);
  await save(serializedValue);
  removeLegacy?.();
}

export function usePersistentState<T>(
  key: string,
  initialValue: T,
  reviver?: (val: unknown) => T,
  serializer?: (value: T) => unknown,
  beforePersist?: (value: T) => Promise<void>,
) {
  const initialValueRef = useRef(initialValue);
  const reviverRef = useRef(reviver);
  const serializerRef = useRef(serializer);
  const beforePersistRef = useRef(beforePersist);
  const skipNextSaveRef = useRef(true);
  const migrateNextSaveRef = useRef(false);
  const removeLegacyNextSaveRef = useRef(false);
  const [value, setValue] = useState<T>(() => initialValue);
  const [isHydrated, setIsHydrated] = useState(false);
  const [metadata, setMetadata] = useState<PersistentStateMetadata>(cleanBackendMetadata);
  const [persistenceFailed, setPersistenceFailed] = useState(false);

  useEffect(() => {
    reviverRef.current = reviver;
  }, [reviver]);

  useEffect(() => {
    serializerRef.current = serializer;
  }, [serializer]);

  useEffect(() => {
    beforePersistRef.current = beforePersist;
  }, [beforePersist]);

  useEffect(() => {
    let cancelled = false;
    setIsHydrated(false);
    setMetadata(cleanBackendMetadata);
    skipNextSaveRef.current = true;
    migrateNextSaveRef.current = false;
    removeLegacyNextSaveRef.current = false;

    void loadPersistentValue(key)
      .then((storedValue) => {
        if (cancelled) {
          return;
        }

        migrateNextSaveRef.current = storedValue.shouldMigrate;
        removeLegacyNextSaveRef.current =
          storedValue.shouldMigrate && storedValue.metadata.source === "legacy-local-storage";
        setMetadata(storedValue.metadata);
        setValue(reviveValue(storedValue.value, initialValueRef.current, reviverRef.current));
      })
      .catch(() => {
        if (!cancelled) {
          setMetadata({ ...cleanBackendMetadata, corrupt: true, degraded: true });
          setValue(initialValueRef.current);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      if (!migrateNextSaveRef.current) {
        return;
      }
    }

    const shouldRemoveLegacy = removeLegacyNextSaveRef.current;
    const persistence = enqueuePersistentWrite(key, () => persistPreparedValue(
      value,
      beforePersistRef.current,
      (currentValue) => serializerRef.current ? serializerRef.current(currentValue) : currentValue,
      (serializedValue) => savePersistentValue(key, serializedValue),
      shouldRemoveLegacy ? () => window.localStorage.removeItem(key) : undefined,
    ));

    void persistence
      .then(() => {
        migrateNextSaveRef.current = false;
        removeLegacyNextSaveRef.current = false;
        setPersistenceFailed(false);
      })
      .catch(() => {
        // App state persistence is best-effort so the UI can keep running. A
        // failed migration deliberately leaves legacy localStorage untouched.
        setPersistenceFailed(true);
      });
  }, [isHydrated, key, value]);

  return [value, setValue, isHydrated, metadata, persistenceFailed] as const;
}
