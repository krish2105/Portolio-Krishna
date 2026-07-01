import { useCallback, useRef, useState } from "react";
import { buildKnowledgeBase, type KBChunk } from "../data/knowledgeBase";

/**
 * Client-side RAG: embeds the portfolio's real content (via transformers.js,
 * fully in-browser) and does semantic search over it. No server, no API key.
 *
 * Flow: enable() lazily loads a small sentence-embedding model, embeds every
 * knowledge-base chunk once (cached in sessionStorage), then search(query)
 * embeds only the query and ranks chunks by cosine similarity.
 */
type EmbedTensor = { tolist: () => number[][] };
type EmbedFn = (input: string | string[], options?: Record<string, unknown>) => Promise<EmbedTensor>;

export type KnowledgeSearchStatus = "idle" | "loading" | "ready" | "error";

const MODEL = "Xenova/all-MiniLM-L6-v2";
const CACHE_KEY = "kb-embeddings-v1";

/** Vectors are L2-normalized (normalize: true), so dot product === cosine similarity. */
const dot = (a: number[], b: number[]): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

export interface KBMatch {
  chunk: KBChunk;
  score: number;
}

export const useKnowledgeSearch = () => {
  const [status, setStatus] = useState<KnowledgeSearchStatus>("idle");
  const [progress, setProgress] = useState(0);
  const pipeRef = useRef<EmbedFn | null>(null);
  const kbRef = useRef<{ chunks: KBChunk[]; vectors: number[][] } | null>(null);

  const enable = useCallback(async (): Promise<boolean> => {
    if (kbRef.current) return true;
    setStatus("loading");
    setProgress(0);
    try {
      const chunks = buildKnowledgeBase();
      const fingerprint = `${chunks.length}:${chunks[0]?.id}:${chunks[chunks.length - 1]?.id}`;

      try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { fingerprint: string; vectors: number[][] };
          if (parsed.fingerprint === fingerprint && parsed.vectors.length === chunks.length) {
            kbRef.current = { chunks, vectors: parsed.vectors };
            setStatus("ready");
            return true;
          }
        }
      } catch {
        /* cache miss/corrupt — fall through and (re)compute */
      }

      if (!pipeRef.current) {
        const mod = await import("@huggingface/transformers");
        const create = mod.pipeline as unknown as (
          t: string,
          m: string,
          o?: Record<string, unknown>
        ) => Promise<EmbedFn>;
        pipeRef.current = await create("feature-extraction", MODEL, {
          progress_callback: (p: { progress?: number }) => {
            if (typeof p.progress === "number") setProgress(Math.min(100, Math.round(p.progress)));
          },
        });
      }

      const output = await pipeRef.current(
        chunks.map((c) => c.text),
        { pooling: "mean", normalize: true }
      );
      const vectors = output.tolist();
      kbRef.current = { chunks, vectors };
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ fingerprint, vectors }));
      } catch {
        /* sessionStorage full/unavailable — search still works, just re-embeds next session */
      }
      setStatus("ready");
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }, []);

  const search = useCallback(async (query: string, topK = 2): Promise<KBMatch[]> => {
    if (!kbRef.current || !pipeRef.current) return [];
    const output = await pipeRef.current([query], { pooling: "mean", normalize: true });
    const [qVec] = output.tolist();
    const { chunks, vectors } = kbRef.current;
    const scored = vectors.map((v, i) => ({ chunk: chunks[i], score: dot(v, qVec) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }, []);

  return { status, progress, enable, search };
};
