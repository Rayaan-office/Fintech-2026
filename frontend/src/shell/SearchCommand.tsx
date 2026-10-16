import { EyeIcon, EyeOffIcon, FileTextIcon, KeyboardIcon, MessageCircleIcon, MoonIcon, SunIcon, UploadIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useCan, useCurrentUser } from "@/api/auth";
import { useSearch } from "@/api/hooks";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { usePrivacy } from "@/lib/privacy";
import { useTheme } from "@/lib/theme";
import { visibleNav } from "./nav";

export function SearchCommand({ open, onOpenChange, onShowShortcuts }: { open: boolean; onOpenChange: (o: boolean) => void; onShowShortcuts: () => void }) {
  const me = useCurrentUser();
  const can = useCan();
  const navigate = useNavigate();
  const privacy = usePrivacy();
  const { theme, setTheme } = useTheme();
  const [q, setQ] = useState("");
  const search = useSearch(open ? q : "");
  const results = search.data?.results ?? [];
  const dark = document.documentElement.classList.contains("dark");

  const run = (fn: () => void) => {
    onOpenChange(false);
    setQ("");
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput value={q} onValueChange={setQ} placeholder="Search bills, customers, suppliers, pages…" />
      <CommandList>
        <CommandEmpty>{search.isFetching ? "Searching…" : "No matches. Try a supplier, customer or amount."}</CommandEmpty>
        {results.length > 0 && (
          <>
            <CommandGroup heading="Records">
              {results.map((r) => (
                <CommandItem key={`${r.kind}:${r.id}`} value={`${r.kind}:${r.id} ${r.label}`} keywords={[q]} onSelect={() => run(() => navigate(r.href))}>
                  <FileTextIcon aria-hidden />
                  <span className="flex-1 truncate">{r.label}</span>
                  <span className="text-xs capitalize text-muted-foreground">{r.kind.replace(/_/g, " ")}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        <CommandGroup heading="Go to">
          {visibleNav(me).map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem key={item.to} value={`Go to ${item.label}`} onSelect={() => run(() => navigate(item.to))}>
                <Icon aria-hidden />
                {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          {can("view_all") && (
            <CommandItem value="Upload a document" onSelect={() => run(() => navigate("/documents?upload=1"))}>
              <UploadIcon aria-hidden /> Upload a document
            </CommandItem>
          )}
          {can("use_assistant") && (
            <CommandItem value="Ask a question" onSelect={() => run(() => navigate("/ask"))}>
              <MessageCircleIcon aria-hidden /> Ask a question
            </CommandItem>
          )}
          <CommandItem value="Privacy mode hide amounts" onSelect={() => run(privacy.toggle)}>
            {privacy.hidden ? <EyeIcon aria-hidden /> : <EyeOffIcon aria-hidden />}
            {privacy.hidden ? "Show amounts" : "Hide amounts (privacy mode)"}
          </CommandItem>
          <CommandItem value="Theme dark light" onSelect={() => run(() => setTheme(dark ? "light" : "dark"))}>
            {dark ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
            {dark ? "Switch to light theme" : "Switch to dark theme"}
            {theme === "system" && <span className="ml-auto text-xs text-muted-foreground">Following your device</span>}
          </CommandItem>
          <CommandItem value="Keyboard shortcuts" onSelect={() => run(onShowShortcuts)}>
            <KeyboardIcon aria-hidden /> Keyboard shortcuts
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
