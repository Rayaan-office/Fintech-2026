import { PauseCircleIcon } from "lucide-react";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Outlet } from "react-router";
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
  useHotkeys("?", () => setShortcutsOpen(true), { useKey: true });

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-panel">
        Skip to content
      </a>
      <Sidebar inboxCount={inboxCount} />
      <div className="flex min-h-dvh flex-col md:pl-60">
        <TopBar onSearch={() => setSearchOpen(true)} onShortcuts={() => setShortcutsOpen(true)} />
        {me.business.ai_paused && (
          <div role="status" className="flex items-center gap-2 border-b bg-warning-soft px-4 py-2 text-sm sm:px-6">
            <PauseCircleIcon className="size-4 text-warning" aria-hidden />
            AI actions are paused. Everything waits for a person until AI is switched back on in Settings.
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
