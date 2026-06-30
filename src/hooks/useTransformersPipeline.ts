import { useCallback, useRef, useState } from "react";

export type PipelineStatus = "idle" | "loading" | "ready" | "error";

type PipeFn = (input: string, options?: Record<string, unknown>) => Promise<unknown>;

/**
 * Lazily loads a transformers.js pipeline IN THE BROWSER (no backend).
 * The heavy library + model download only happen on first `run()` — gated by
 * user intent — so nothing affects initial page load. Falls back gracefully:
 * on any failure `status` becomes "error" and `run` returns null.
 */
export const useTransformersPipeline = (task: string, model: string) => {
  const [status, setStatus] = useState<PipelineStatus>("idle");
  const [progress, setProgress] = useState(0);
  const pipeRef = useRef<PipeFn | null>(null);

  const ensureLoaded = useCallback(async (): Promise<boolean> => {
    if (pipeRef.current) return true;
    setStatus("loading");
    setProgress(0);
    try {
      const mod = await import("@huggingface/transformers");
      const create = mod.pipeline as unknown as (
        t: string,
        m: string,
        o?: Record<string, unknown>
      ) => Promise<PipeFn>;
      pipeRef.current = await create(task, model, {
        progress_callback: (p: { progress?: number }) => {
          if (typeof p.progress === "number") setProgress(Math.min(100, Math.round(p.progress)));
        },
      });
      setStatus("ready");
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }, [task, model]);

  const run = useCallback(
    async (input: string, options?: Record<string, unknown>): Promise<unknown> => {
      const ok = pipeRef.current ? true : await ensureLoaded();
      if (!ok || !pipeRef.current) return null;
      return pipeRef.current(input, options);
    },
    [ensureLoaded]
  );

  return { status, progress, run };
};
