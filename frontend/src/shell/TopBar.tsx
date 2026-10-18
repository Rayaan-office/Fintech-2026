import { BellIcon, EyeIcon, EyeOffIcon, KeyboardIcon, LogOutIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useCurrentUser, useLogout } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useMarkNotificationsRead, useNotifications } from "@/api/hooks";
import { Initials } from "@/components/Initials";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/format";
import { usePrivacy } from "@/lib/privacy";
import { rolesText } from "./roles";
import { keyLabel } from "./shortcuts";

export function TopBar({ onSearch, onShortcuts }: { onSearch: () => void; onShortcuts: () => void }) {
  const me = useCurrentUser();
  const privacy = usePrivacy();

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 bg-background/85 px-4 backdrop-blur-md sm:px-6 lg:px-8">
      <span className="flex min-w-0 items-center gap-2 md:hidden">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-[13px] font-semibold text-background" aria-hidden>
          {me.business.name.trim()[0]?.toUpperCase() ?? "S"}
        </span>
        <span className="truncate text-sm font-semibold">{me.business.name}</span>
      </span>
      <button
        type="button"
        onClick={onSearch}
        className="group ml-auto flex size-9 shrink-0 items-center md:min-w-0 md:shrink justify-center gap-2.5 rounded-full text-sm text-muted-foreground transition-colors hover:bg-accent md:ml-0 md:h-10 md:w-full md:max-w-xl md:justify-start md:bg-secondary md:px-4 md:hover:bg-accent"
        aria-label="Search everything"
      >
        <SearchIcon className="size-4 shrink-0" aria-hidden />
        <span className="hidden flex-1 truncate text-left md:inline">Search everything</span>
        <span className="hidden items-center gap-0.5 md:flex" aria-hidden>
          <Kbd className="bg-card">{keyLabel("mod")}</Kbd>
          <Kbd className="bg-card">K</Kbd>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 md:ml-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground aria-pressed:text-foreground"
              onClick={privacy.toggle}
              aria-pressed={privacy.hidden}
              aria-label={privacy.hidden ? "Show amounts" : "Hide amounts"}
            >
              {privacy.hidden ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{privacy.hidden ? "Show amounts" : "Hide amounts"}</TooltipContent>
        </Tooltip>
        <NotificationsButton unread={me.unread_notifications} />
        <UserMenu onShortcuts={onShortcuts} />
      </div>
    </header>
  );
}

function NotificationsButton({ unread }: { unread: number }) {
  const navigate = useNavigate();
  const list = useNotifications(true);
  const markRead = useMarkNotificationsRead();
  const items = list.data?.items ?? [];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <BellIcon aria-hidden />
          {unread > 0 && <span className="absolute right-2.5 top-2.5 size-2 rounded-full bg-primary ring-2 ring-background" aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Notifications</h2>
          {unread > 0 && (
            <Button variant="link" size="sm" onClick={() => markRead.mutate(undefined, { onError: (e) => toast.error(errorMessage(e)) })}>
              Mark all as read
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">You're all caught up.</p>
        ) : (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="flex w-full gap-3 px-4 py-3 text-left hover:bg-accent disabled:cursor-default"
                  disabled={!n.link}
                  onClick={() => n.link && navigate(n.link)}
                >
                  <span className={n.read ? "mt-1.5 size-1.5 shrink-0" : "mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"} aria-hidden />
                  <span className="grid gap-0.5">
                    <span className="text-sm">{n.title}</span>
                    <span className="text-xs text-muted-foreground">{formatRelative(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function UserMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const me = useCurrentUser();
  const navigate = useNavigate();
  const logout = useLogout();

  const signOut = () =>
    logout.mutate(undefined, {
      onSettled: () => navigate("/sign-in", { replace: true }),
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ml-1.5 rounded-full outline-offset-2 transition-opacity hover:opacity-90" aria-label={`Account menu for ${me.user.name}`}>
          <Initials name={me.user.name} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>
          <div className="font-medium">{me.user.name}</div>
          <div className="truncate text-xs font-normal text-muted-foreground">{me.user.email}</div>
          <div className="mt-1 text-xs font-normal text-muted-foreground">{rolesText(me.user.roles)}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/settings")}>
          <SettingsIcon aria-hidden /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onShortcuts}>
          <KeyboardIcon aria-hidden /> Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOutIcon aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
