import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

const memoryStateStore = new Map<string, unknown>();

interface LoadedPersistentValue {
  value: unknown | null;
  shouldMigrate: boolean;
}

interface AppStatePayload {
  exists: boolean;
  value: unknown | null;
}

function reviveValue<T>(value: unknown, initialValue: T, reviver?: (val: unknown) => T) {
  if (value === null) {
    return initialValue;
  }

  return reviver ? reviver(value) : (value as T);
}

function loadLegacyLocalStorageValue(key: string): LoadedPersistentValue {
  try {
    const storedValue = window.localStorage.getItem(key);

    if (storedValue === null) {
      return {
        value: null,
        shouldMigrate: false,
      };
    }

    return {
      value: JSON.parse(storedValue),
      shouldMigrate: true,
    };
  } catch {
    return {
      value: null,
      shouldMigrate: false,
    };
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

async function loadPersistentValue(key: string): Promise<LoadedPersistentValue> {
  if (!isTauri()) {
    return {
      value: memoryStateStore.has(key) ? memoryStateStore.get(key) ?? null : null,
      shouldMigrate: false,
    };
  }

  const storedValue = await invoke<AppStatePayload | unknown | null>("load_app_state", { key });

  if (isAppStatePayload(storedValue)) {
    if (!storedValue.exists) {
      return loadLegacyLocalStorageValue(key);
    }

    return {
      value: storedValue.value ?? null,
      shouldMigrate: false,
    };
  }

  if (storedValue !== null) {
    return {
      value: storedValue,
      shouldMigrate: false,
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
  const [value, setValue] = useState<T>(() => {
    return initialValue;
  });
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    reviverRef.current = reviver;
  }, [reviver]);

  useEffect(() => {
    serializerRef.current = serializer;
  }, [serializer]);

  useEffect(() => {
    let cancelled = false;
    setIsHydrated(false);
    skipNextSaveRef.current = true;
    migrateNextSaveRef.current = false;

    void loadPersistentValue(key)
      .then((storedValue) => {
        if (cancelled) {
          return;
        }

        migrateNextSaveRef.current = storedValue.shouldMigrate;
        setValue(reviveValue(storedValue.value, initialValueRef.current, reviverRef.current));
      })
      .catch(() => {
        if (!cancelled) {
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

    const shouldClearLegacyStorage = migrateNextSaveRef.current;
    migrateNextSaveRef.current = false;
    const serializedValue = serializerRef.current ? serializerRef.current(value) : value;

    void savePersistentValue(key, serializedValue)
      .then(() => {
        if (shouldClearLegacyStorage && isTauri()) {
          window.localStorage.removeItem(key);
        }
      })
      .catch(() => {
        // App state persistence is best-effort so the UI can keep running.
      });
  }, [isHydrated, key, value]);

  return [value, setValue, isHydrated] as const;
}
