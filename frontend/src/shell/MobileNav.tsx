import { EllipsisIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useState } from "react";
import { NavLink } from "react-router";
import { useCurrentUser } from "@/api/auth";
import { cn } from "@/lib/utils";
import { visibleNav } from "./nav";
import { BrandMark, NavList } from "./Sidebar";

/** Phone: a bottom bar with the main places and a "More" drawer with everything. */
export function MobileNav({ inboxCount }: { inboxCount?: number }) {
  const me = useCurrentUser();
  const [open, setOpen] = useState(false);
  const items = visibleNav(me).filter((i) => i.phone).slice(0, 4);

  return (
    <>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="flex">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to} className="flex-1">
                <NavLink
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    cn("relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground", isActive && "text-primary")
                  }
                >
                  <Icon className="size-5" aria-hidden />
                  <span className="max-w-full truncate px-1">{item.label}</span>
                  {item.to === "/inbox" && inboxCount ? (
                    <span className="absolute left-1/2 top-1.5 ml-2 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground tabular">
                      {inboxCount > 99 ? "99+" : inboxCount}
                    </span>
                  ) : null}
                </NavLink>
              </li>
            );
          })}
          <li className="flex-1">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground"
            >
              <EllipsisIcon className="size-5" aria-hidden />
              More
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
                  className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar px-3 pb-6 pt-4 shadow-panel"
                >
                  <div className="flex items-center justify-between">
                    <BrandMark name={me.business.name} />
                    <DialogPrimitive.Close className="rounded-md p-2 text-muted-foreground hover:bg-accent">
                      <XIcon className="size-4" aria-hidden />
                      <span className="sr-only">Close menu</span>
                    </DialogPrimitive.Close>
                  </div>
                  <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
                  <div className="mt-6 flex flex-1 flex-col overflow-y-auto">
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
