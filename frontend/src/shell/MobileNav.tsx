import { EllipsisIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useState } from "react";
import { NavLink, matchPath, useLocation } from "react-router";
import { useCurrentUser } from "@/api/auth";
import { cn } from "@/lib/utils";
import { visibleNav } from "./nav";
import { BrandMark, NavList } from "./Sidebar";

/** Phone: a bottom bar with the main places and a "More" drawer with everything. */
export function MobileNav({ inboxCount }: { inboxCount?: number }) {
  const me = useCurrentUser();
  const [open, setOpen] = useState(false);
  const items = visibleNav(me).filter((i) => i.phone).slice(0, 4);
  const { pathname } = useLocation();
  // "More" reads as the current place when the page lives in the drawer
  const inDrawer = !items.some((i) => matchPath({ path: i.to, end: i.to === "/" }, pathname));

  return (
    <>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
        <ul className="flex">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to} className="flex-1">
                <NavLink
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    cn("group relative flex h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground", isActive && "text-foreground")
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={cn("flex h-7 w-12 items-center justify-center rounded-full transition-colors", isActive && "bg-accent")}>
                        <Icon className="size-[18px]" aria-hidden />
                      </span>
                      <span className="max-w-full truncate px-1 leading-none">{item.label}</span>
                      {item.to === "/inbox" && inboxCount ? (
                        <span
                          aria-label={`${inboxCount} waiting`}
                          className="absolute left-1/2 top-1 ml-1.5 min-w-4 rounded-full bg-foreground px-1 text-center text-[10px] leading-4 text-background tabular"
                        >
                          {inboxCount > 99 ? "99+" : inboxCount}
                        </span>
                      ) : null}
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
          <li className="flex-1">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              className={cn("flex h-14 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground", inDrawer && "text-foreground")}
            >
              <span className={cn("flex h-7 w-12 items-center justify-center rounded-full", inDrawer && "bg-accent")}>
                <EllipsisIcon className="size-[18px]" aria-hidden />
              </span>
              <span className="leading-none">More</span>
            </button>
          </li>
        </ul>
      </nav>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <AnimatePresence>
          {open && (
            <DialogPrimitive.Portal forceMount>
              <DialogPrimitive.Overlay asChild forceMount>
                <motion.div className="fixed inset-0 z-50 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
              </DialogPrimitive.Overlay>
              <DialogPrimitive.Content asChild forceMount aria-describedby={undefined}>
                <motion.div
                  initial={{ x: "-100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "-100%" }}
                  transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
                  className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar px-3 pb-6 pt-3 shadow-panel"
                >
                  <div className="flex h-10 items-center justify-between">
                    <BrandMark name={me.business.name} />
                    <DialogPrimitive.Close className="rounded-full p-2 text-muted-foreground hover:bg-accent">
                      <XIcon className="size-4" aria-hidden />
                      <span className="sr-only">Close menu</span>
                    </DialogPrimitive.Close>
                  </div>
                  <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
                  <div className="mt-4 flex flex-1 flex-col overflow-y-auto">
                    <NavList inboxCount={inboxCount} onNavigate={() => setOpen(false)} />
                  </div>
                </motion.div>
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          )}
        </AnimatePresence>
      </DialogPrimitive.Root>
    </>
  );
}
