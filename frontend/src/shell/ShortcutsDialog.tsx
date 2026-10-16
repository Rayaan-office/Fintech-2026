import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { keyLabel, SHORTCUTS } from "./shortcuts";

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Work faster without the mouse.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {SHORTCUTS.map((g) => (
            <section key={g.group}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.group}</h3>
              <dl className="grid gap-2">
                {g.items.map((s) => (
                  <div key={s.label} className="flex items-center justify-between gap-4 text-sm">
                    <dt>{s.label}</dt>
                    <dd className="flex gap-1">
                      {s.keys.map((k) => (
                        <Kbd key={k}>{keyLabel(k)}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
