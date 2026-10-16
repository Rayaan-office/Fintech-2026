import { XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const ease = [0.32, 0.72, 0, 1] as const;

type PanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

// Radix links the description automatically; without one it needs an explicit "none"
const describedBy = (description: ReactNode) => (description ? {} : { "aria-describedby": undefined });

function PanelHeader({ title, description, actions }: Pick<PanelProps, "title" | "description" | "actions">) {
  return (
    <header className="flex items-start gap-3 border-b px-5 py-4">
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="truncate text-base font-semibold">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-0.5 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
        ) : null}
      </div>
      {actions}
      <DialogPrimitive.Close className="-mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        <XIcon className="size-4" aria-hidden />
        <span className="sr-only">Close panel</span>
      </DialogPrimitive.Close>
    </header>
  );
}

/**
 * Looking at a record in context. Slides in from the right; the list behind stays visible and
 * usable, so clicking another row swaps the panel instead of closing it. Esc closes.
 */
export function SidePanel({ open, onOpenChange, title, description, actions, children, className }: PanelProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Content
              asChild
              forceMount
              {...describedBy(description)}
              onInteractOutside={(e) => e.preventDefault()}
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <motion.aside
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ duration: 0.24, ease }}
                className={cn(
                  "fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-card shadow-panel sm:top-2 sm:right-2 sm:bottom-2 sm:rounded-xl sm:border",
                  className,
                )}
              >
                <PanelHeader title={title} description={description} actions={actions} />
                <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
              </motion.aside>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

/** Tasks to finish start to finish (review a document, approve a payment). Wider, dims the page. */
export function FocusedPanel({ open, onOpenChange, title, description, actions, children, className }: PanelProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount {...describedBy(description)}>
              <motion.div
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ duration: 0.28, ease }}
                className={cn(
                  "fixed inset-y-0 right-0 z-50 flex w-full max-w-5xl flex-col bg-card shadow-panel sm:top-2 sm:right-2 sm:bottom-2 sm:w-[calc(100%-1rem)] sm:rounded-xl sm:border",
                  className,
                )}
              >
                <PanelHeader title={title} description={description} actions={actions} />
                <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
