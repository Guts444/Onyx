import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

const memoryStateStore = new Map<string, unknown>();

function reviveValue<T>(value: unknown, initialValue: T, reviver?: (val: unknown) => T) {
  if (value === null) {
    return initialValue;
  }

  return reviver ? reviver(value) : (value as T);
}

async function loadPersistentValue(key: string) {
  if (!isTauri()) {
    return memoryStateStore.has(key) ? memoryStateStore.get(key) ?? null : null;
  }

  return invoke<unknown | null>("load_app_state", { key });
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

    void loadPersistentValue(key)
      .then((storedValue) => {
        if (cancelled) {
          return;
        }

        setValue(reviveValue(storedValue, initialValueRef.current, reviverRef.current));
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
      return;
    }

    const serializedValue = serializerRef.current ? serializerRef.current(value) : value;

    void savePersistentValue(key, serializedValue).catch(() => {
      // App state persistence is best-effort so the UI can keep running.
    });
  }, [isHydrated, key, value]);

  return [value, setValue, isHydrated] as const;
}
