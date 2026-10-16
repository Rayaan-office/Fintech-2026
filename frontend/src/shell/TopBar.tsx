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
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur sm:px-6">
      <span className="truncate text-sm font-semibold md:hidden">{me.business.name}</span>
      <button
        type="button"
        onClick={onSearch}
        className="ml-auto flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground shadow-card hover:bg-accent md:ml-0 md:w-full md:max-w-sm"
        aria-label="Search everything"
      >
        <SearchIcon className="size-4" aria-hidden />
        <span className="hidden flex-1 text-left md:inline">Search everything</span>
        <span className="hidden gap-0.5 md:flex" aria-hidden>
          <Kbd>{keyLabel("mod")}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="flex items-center gap-1 md:ml-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={privacy.toggle} aria-pressed={privacy.hidden} aria-label={privacy.hidden ? "Show amounts" : "Hide amounts"}>
              {privacy.hidden ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{privacy.hidden ? "Amounts are hidden. Click to show." : "Hide all amounts (privacy mode)"}</TooltipContent>
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
        <Button variant="ghost" size="icon" className="relative" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <BellIcon aria-hidden />
          {unread > 0 && <span className="absolute right-2 top-2 size-2 rounded-full bg-primary ring-2 ring-background" aria-hidden />}
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
        <button type="button" className="ml-1 rounded-full" aria-label={`Account menu for ${me.user.name}`}>
          <Initials name={me.user.name} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>
          <div className="font-medium">{me.user.name}</div>
          <div className="truncate text-xs font-normal text-muted-foreground">{me.user.email}</div>
          <div className="mt-1 text-xs font-normal text-muted-foreground">
            {rolesText(me.user.roles)} · {me.business.name}
          </div>
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
