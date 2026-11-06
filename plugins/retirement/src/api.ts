import { useCallback, useEffect, useRef, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';

/** Small authenticated client for the retirement-demo backend routes. */
export function useDemoClient() {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);

  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const base = await discoveryApi.getBaseUrl('retirement-demo');
      const res = await fetchApi.fetch(`${base}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        const message = body?.error?.message ?? `${res.status} ${res.statusText}`;
        const err = new Error(message);
        err.name = body?.error?.name ?? 'Error';
        throw err;
      }
      return body as T;
    },
    [discoveryApi, fetchApi],
  );
}

/** Polls a backend route. The UI event transport is plain HTTP polling, not MCP. */
export function usePolling<T>(path: string | undefined, intervalMs: number) {
  const client = useDemoClient();
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<Error>();
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      const v = await client<T>(path);
      if (mounted.current) {
        setValue(v);
        setError(undefined);
        setUpdatedAt(new Date());
      }
    } catch (e) {
      if (mounted.current) setError(e as Error);
    }
  }, [client, path]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { value, error, updatedAt, refresh };
}
