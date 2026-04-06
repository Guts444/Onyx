import { useEffect, useState } from "react";

export function usePersistentState<T>(key: string, initialValue: T, reviver?: (val: unknown) => T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const storedValue = window.localStorage.getItem(key);

      if (storedValue === null) {
        return initialValue;
      }

      const parsedValue = JSON.parse(storedValue);
      return reviver ? reviver(parsedValue) : (parsedValue as T);
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Local persistence is a best-effort convenience for v1.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
