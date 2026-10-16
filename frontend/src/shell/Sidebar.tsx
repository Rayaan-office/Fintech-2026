import { NavLink } from "react-router";
import { useCurrentUser } from "@/api/auth";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { visibleNav, type NavItem } from "./nav";

export function NavEntry({ item, count, onNavigate }: { item: NavItem; count?: number; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          isActive && "bg-card text-foreground shadow-card ring-1 ring-border",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={cn("size-4 shrink-0", isActive && "text-primary")} aria-hidden />
          <span className="flex-1 truncate">{item.label}</span>
          {count ? (
            <Badge variant="count" aria-label={`${count} waiting`}>
              {count > 99 ? "99+" : count}
            </Badge>
          ) : null}
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
        {main.map((item) => (
          <NavEntry key={item.to} item={item} count={item.to === "/inbox" ? inboxCount : undefined} onNavigate={onNavigate} />
        ))}
      </nav>
      <nav aria-label="Settings" className="mt-auto grid gap-0.5 pt-6">
        {bottom.map((item) => (
          <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </nav>
    </>
  );
}

export function BrandMark({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3">
      <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground" aria-hidden>
        {name.trim()[0]?.toUpperCase() ?? "S"}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{name}</span>
        <span className="block text-xs text-muted-foreground">Finance Copilot</span>
      </span>
    </div>
  );
}

export function Sidebar({ inboxCount }: { inboxCount?: number }) {
  const me = useCurrentUser();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-sidebar px-3 pb-4 pt-4 md:flex">
      <BrandMark name={me.business.name} />
      <div className="mt-6 flex flex-1 flex-col overflow-y-auto">
        <NavList inboxCount={inboxCount} />
      </div>
    </aside>
  );
}
