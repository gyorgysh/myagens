import { useEffect, useState } from "react";
import { AuthError } from "../api.ts";

/** Poll an async fetcher on an interval, surfacing data/error/loading.
 *  Auth failures bubble up via onAuthError so the app can drop to login. */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  onAuthError: () => void,
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const next = await fetcher();
        if (!stop) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (e instanceof AuthError) {
          onAuthError();
          return;
        }
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stop) setLoading(false);
      }
    };
    void tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      stop = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return { data, error, loading };
}
