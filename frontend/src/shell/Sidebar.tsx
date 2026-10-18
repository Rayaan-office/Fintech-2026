import { ChevronsUpDownIcon, PlugIcon, SettingsIcon } from "lucide-react";
import { Fragment } from "react";
import { NavLink, useNavigate } from "react-router";
import { useCan, useCurrentUser } from "@/api/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, visibleNav, type NavItem } from "./nav";

/** A count beside a menu item, quiet until it is the one you're on. */
export function CountPill({ count, active }: { count: number; active?: boolean }) {
  return (
    <span
      aria-label={`${count} waiting`}
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular",
        active ? "bg-card text-foreground shadow-card" : "bg-muted text-muted-foreground",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function NavEntry({ item, count, onNavigate }: { item: NavItem; count?: number; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          isActive && "bg-accent text-foreground",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={cn("size-4 shrink-0", isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")} aria-hidden />
          <span className="flex-1 truncate">{item.label}</span>
          {count ? <CountPill count={count} active={isActive} /> : null}
        </>
      )}
    </NavLink>
  );
}

export function NavList({ inboxCount, onNavigate }: { inboxCount?: number; onNavigate?: () => void }) {
  const me = useCurrentUser();
  const items = visibleNav(me);
  const main = items.filter((i) => i.place === "main");
  const bottom = items.filter((i) => i.place === "bottom");
  return (
    <>
      <nav aria-label="Main" className="grid gap-0.5">
        {main.map((item, i) => {
          // A small label where a new group starts
          const label = item.group && item.group !== main[i - 1]?.group ? NAV_GROUPS[item.group] : null;
          return (
            <Fragment key={item.to}>
              {label && <div className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">{label}</div>}
              <NavEntry item={item} count={item.to === "/inbox" ? inboxCount : undefined} onNavigate={onNavigate} />
            </Fragment>
          );
        })}
      </nav>
      <nav aria-label="Settings" className="mt-auto grid gap-0.5 pt-6">
        {bottom.map((item) => (
          <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </nav>
    </>
  );
}

function BusinessTile({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-[13px] font-semibold text-background", className)} aria-hidden>
      {name.trim()[0]?.toUpperCase() ?? "S"}
    </span>
  );
}

export function BrandMark({ name }: { name: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-2.5">
      <BusinessTile name={name} />
      <span className="truncate text-sm font-semibold">{name}</span>
    </div>
  );
}

/** The business at the top of the sidebar, like a bank's account switcher: one business today. */
export function BusinessMenu({ onNavigate }: { onNavigate?: () => void }) {
  const me = useCurrentUser();
  const can = useCan();
  const navigate = useNavigate();
  const go = (to: string) => {
    onNavigate?.();
    navigate(to);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Business: ${me.business.name}`}
          className="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-accent data-[state=open]:bg-accent"
        >
          <BusinessTile name={me.business.name} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{me.business.name}</span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-2.5">
          <BusinessTile name={me.business.name} className="size-8" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{me.business.name}</span>
            <span className="block text-xs font-normal text-muted-foreground">Finance Copilot</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go("/settings")}>
          <SettingsIcon aria-hidden /> Settings
        </DropdownMenuItem>
        {can("view_all") && (
          <DropdownMenuItem onSelect={() => go("/connections")}>
            <PlugIcon aria-hidden /> Connections
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar({ inboxCount }: { inboxCount?: number }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border/60 bg-sidebar px-3 pb-4 pt-3 md:flex">
      <BusinessMenu />
      <div className="mt-4 flex flex-1 flex-col overflow-y-auto">
        <NavList inboxCount={inboxCount} />
      </div>
    </aside>
  );
}
