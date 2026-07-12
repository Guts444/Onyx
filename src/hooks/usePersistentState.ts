import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

const memoryStateStore = new Map<string, unknown>();

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

export function usePersistentState<T>(
  key: string,
  initialValue: T,
  reviver?: (val: unknown) => T,
  serializer?: (value: T) => unknown,
) {
  const initialValueRef = useRef(initialValue);
  const reviverRef = useRef(reviver);
  const serializerRef = useRef(serializer);
  const skipNextSaveRef = useRef(true);
  const migrateNextSaveRef = useRef(false);
  const [value, setValue] = useState<T>(() => initialValue);
  const [isHydrated, setIsHydrated] = useState(false);
  const [metadata, setMetadata] = useState<PersistentStateMetadata>(cleanBackendMetadata);

  useEffect(() => {
    reviverRef.current = reviver;
  }, [reviver]);

  useEffect(() => {
    serializerRef.current = serializer;
  }, [serializer]);

  useEffect(() => {
    let cancelled = false;
    setIsHydrated(false);
    setMetadata(cleanBackendMetadata);
    skipNextSaveRef.current = true;
    migrateNextSaveRef.current = false;

    void loadPersistentValue(key)
      .then((storedValue) => {
        if (cancelled) {
          return;
        }

        migrateNextSaveRef.current = storedValue.shouldMigrate;
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

    migrateNextSaveRef.current = false;
    const serializedValue = serializerRef.current ? serializerRef.current(value) : value;

    void savePersistentValue(key, serializedValue).catch(() => {
      // App state persistence is best-effort so the UI can keep running.
    });
  }, [isHydrated, key, value]);

  return [value, setValue, isHydrated, metadata] as const;
}
