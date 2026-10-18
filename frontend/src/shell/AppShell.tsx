import { PauseCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Link, Outlet } from "react-router";
import { useCan, useCurrentUser } from "@/api/auth";
import { useInbox } from "@/api/hooks";
import { useLiveUpdates } from "@/api/live";
import { MobileNav } from "./MobileNav";
import { SearchCommand } from "./SearchCommand";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppShell() {
  const me = useCurrentUser();
  const can = useCan();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const inbox = useInbox("needs_approval", can("view_all"));
  useLiveUpdates();
  const counts = inbox.data?.counts;
  const inboxCount = counts ? counts.to_review + counts.needs_approval : undefined;

  useHotkeys("mod+k", (e) => {
    e.preventDefault();
    setSearchOpen((o) => !o);
  }, { enableOnFormTags: true, enableOnContentEditable: true });
  // "?" is typed with Shift on most keyboards, and on another key on some, so we match the character itself
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-panel">
        Skip to content
      </a>
      <Sidebar inboxCount={inboxCount} />
      <div className="flex min-h-dvh flex-col md:pl-60">
        <TopBar onSearch={() => setSearchOpen(true)} onShortcuts={() => setShortcutsOpen(true)} />
        {me.business.ai_paused && (
          <div role="status" className="mx-4 mt-1 flex items-center gap-2 rounded-full bg-warning-soft px-4 py-1.5 text-sm sm:mx-6 lg:mx-8">
            <PauseCircleIcon className="size-4 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1">AI actions are paused. Everything waits for a person.</span>
            <Link to="/settings" className="shrink-0 font-medium underline-offset-4 hover:underline">
              Settings
            </Link>
          </div>
        )}
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-6 outline-none sm:px-6 md:pb-10 lg:px-8">
          <Outlet />
        </main>
      </div>
      <MobileNav inboxCount={inboxCount} />
      <SearchCommand open={searchOpen} onOpenChange={setSearchOpen} onShowShortcuts={() => setShortcutsOpen(true)} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}
