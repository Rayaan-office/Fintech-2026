import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/** What each kind of server event can change on screen. Events carry IDs and stages only, never document text. */
const AFFECTS: Record<string, string[]> = {
  document: ["documents", "inbox", "activity"],
  action: ["inbox", "documents", "activity", "home", "recommendations"],
  connection: ["connections", "activity"],
  matches: ["inbox", "activity", "home"],
  recommendations: ["recommendations", "home"],
  forecast: ["cash-flow", "financing", "home"],
  email_sent: ["activity"],
  ai_pause: ["me", "activity"],
};

/**
 * Keeps every open screen current: the server pushes a short event whenever something changes,
 * and we refetch only what that kind of event affects. A burst of events (a document going
 * through its steps) becomes one refetch per screen.
 */
export function useLiveUpdates(enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const source = new EventSource("/api/events", { withCredentials: true });
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      timer = undefined;
      for (const key of pending) void qc.invalidateQueries({ queryKey: [key] });
      pending.clear();
    };

    source.addEventListener("update", (e) => {
      let kind: unknown;
      try {
        kind = (JSON.parse((e as MessageEvent<string>).data) as { event?: unknown }).event;
      } catch {
        return;
      }
      for (const key of AFFECTS[String(kind)] ?? []) pending.add(key);
      if (pending.size && !timer) timer = setTimeout(flush, 250);
    });
    // The browser reconnects on its own after a dropped connection; catch up on anything missed
    let opened = false;
    source.addEventListener("open", () => {
      if (!opened) return void (opened = true);
      for (const key of new Set(Object.values(AFFECTS).flat())) pending.add(key);
      if (!timer) timer = setTimeout(flush, 250);
    });

    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, qc]);
}

// Learning from decisions: decisions and newly read documents change what we've learned
for (const kind of ["action", "document", "recommendations"]) AFFECTS[kind]?.push("learning");
