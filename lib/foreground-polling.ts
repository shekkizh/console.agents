"use client";

import { useEffect, useRef } from "react";

// This limits browser monitoring only; agent execution is independent.
export const FOREGROUND_POLLING_WINDOW_MS = 15 * 60_000;

type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

// Wait for each request to finish; hidden tabs generate no polling traffic.
export function startForegroundPolling(
  intervalMs: number, poll: () => Promise<unknown>, surface: Visibility,
  onLimit?: () => void, durationMs = FOREGROUND_POLLING_WINDOW_MS,
): () => void {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + durationMs;
  const limit = setTimeout(() => {
    stopped = true;
    clearTimeout(timer);
    onLimit?.();
  }, durationMs);
  const schedule = () => {
    if (!stopped && !surface.hidden) timer = setTimeout(() => void tick(), intervalMs);
  };
  const tick = async () => {
    if (stopped || Date.now() >= deadline || surface.hidden || inFlight) return;
    inFlight = true;
    try { await poll(); } catch { /* Retry at the next visible tick. */ }
    finally { inFlight = false; schedule(); }
  };
  const visibility = () => {
    clearTimeout(timer);
    if (!surface.hidden) void tick();
  };
  surface.addEventListener("visibilitychange", visibility);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(limit);
    surface.removeEventListener("visibilitychange", visibility);
  };
}

export function useForegroundPolling(enabled: boolean, intervalMs: number, poll: () => Promise<unknown>, onLimit?: () => void, restartKey = 0) {
  const latest = useRef(poll);
  const expired = useRef(onLimit);
  useEffect(() => { latest.current = poll; }, [poll]);
  useEffect(() => { expired.current = onLimit; }, [onLimit]);
  useEffect(() => {
    if (!enabled) return;
    return startForegroundPolling(intervalMs, () => latest.current(), document, () => expired.current?.());
  }, [enabled, intervalMs, restartKey]);
}
