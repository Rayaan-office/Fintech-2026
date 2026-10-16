import {
  BuildingIcon,
  ClockIcon,
  LandmarkIcon,
  LightbulbIcon,
  TrendingUpIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useDismissRecommendation, useRecommendations } from "@/api/hooks";
import type { Recommendation, RecommendationType } from "@/api/types";
import { ActionConfirmation } from "@/components/ActionConfirmation";
import { AiText } from "@/components/AiText";
import { Initials } from "@/components/Initials";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { SidePanel } from "@/components/panels";
import { QueryView } from "@/components/QueryView";
import { ListSkeleton } from "@/components/skeletons";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { WhyHint } from "@/components/WhyHint";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const RECOMMENDATION_TYPES: Record<RecommendationType, { label: string; icon: LucideIcon; risky?: boolean }> = {
  supplier_details_changed: { label: "Supplier details changed", icon: BuildingIcon },
  bank_details_changed: { label: "Bank details changed", icon: LandmarkIcon, risky: true },
  price_rise: { label: "Price rise", icon: TrendingUpIcon },
  slow_payer: { label: "Slow-paying customer", icon: ClockIcon },
  spending_creep: { label: "Spending creep", icon: WalletIcon },
  customer_concentration: { label: "Reliance on one customer", icon: UsersIcon },
};

export default function RecommendationsPage() {
  const recs = useRecommendations();
  return (
    <div className="grid gap-6">
      <PageHeader title="Recommendations" description="Things we spotted in your records, each with the numbers behind it and one next step." />
      <QueryView
        query={recs}
        loading={<ListSkeleton rows={4} />}
        empty={<NoRecommendations />}
      >
        {(data) => (data.items.length === 0 ? <NoRecommendations /> : <RecommendationList items={data.items} />)}
      </QueryView>
    </div>
  );
}

function NoRecommendations() {
  return (
    <EmptyState
      icon={LightbulbIcon}
      title="No recommendations right now"
      description="We review your records whenever new data arrives and once a day. Anything worth your attention will appear here."
    />
  );
}

function RecommendationList({ items }: { items: Recommendation[] }) {
  const currency = useCurrentUser().business.currency;
  const dismiss = useDismissRecommendation();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = items.find((r) => r.id === openId) ?? null;

  return (
    <>
      <ul className="grid gap-4">
        <AnimatePresence initial={false}>
          {items.map((r) => {
            const type = RECOMMENDATION_TYPES[r.type];
            const Icon = type.icon;
            return (
              <motion.li
                key={r.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 40 }}
                transition={{ duration: 0.2 }}
                className={cn("rounded-xl border bg-card shadow-card", openId === r.id && "ring-2 ring-primary/40")}
              >
                <div className="flex flex-wrap items-start gap-4 p-5">
                  <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", type.risky ? "bg-warning-soft text-warning" : "bg-primary-soft text-primary")}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="grid min-w-0 flex-1 gap-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-xs font-medium text-muted-foreground">{type.label}</span>
                      <span className="text-xs text-muted-foreground">{formatRelative(r.created_at)}</span>
                    </div>
                    <h2 className="text-[15px] font-semibold">{r.title}</h2>
                    <AiText text={r.summary.text} redactedInput={r.summary.redacted_input} />
                    <WhyHint why={r.why} />
                  </div>
                  {r.at_stake_minor !== null && (
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground">At stake</div>
                      <div className="text-lg font-semibold">
                        <Money minor={r.at_stake_minor} currency={currency} />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
                  {r.next_step && <Button onClick={() => setOpenId(r.id)}>{r.next_step.label}</Button>}
                  <Button variant="secondary" onClick={() => setOpenId(r.id)}>
                    See before and after
                  </Button>
                  <Button
                    variant="ghost"
                    className="ml-auto"
                    disabled={dismiss.isPending}
                    onClick={() =>
                      dismiss.mutate(r.id, {
                        onSuccess: () => toast("Recommendation dismissed. We won't raise it again unless something changes."),
                        onError: (err) => toast.error(errorMessage(err)),
                      })
                    }
                  >
                    Dismiss
                  </Button>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      <SidePanel open={open !== null} onOpenChange={(o) => !o && setOpenId(null)} title={open?.title ?? ""} description={open ? RECOMMENDATION_TYPES[open.type].label : undefined}>
        {open && (
          <div className="grid gap-6">
            {open.counterparty && (
              <div className="flex items-center gap-3">
                <Initials name={open.counterparty} size="lg" />
                <span className="font-medium">{open.counterparty}</span>
              </div>
            )}
            {open.evidence.length > 0 && (
              <section aria-label="Before and after">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="py-2 pr-2 font-medium" />
                      <th scope="col" className="py-2 pr-2 font-medium">Before</th>
                      <th scope="col" className="py-2 font-medium">Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.evidence.map((e) => (
                      <tr key={e.label} className="border-b last:border-0 align-top">
                        <th scope="row" className="py-2 pr-2 text-left font-normal text-muted-foreground">{e.label}</th>
                        <td className="py-2 pr-2 tabular">{e.before}</td>
                        <td className="py-2 font-medium tabular">{e.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            {open.next_step && <ActionConfirmation confirmation={open.next_step.confirmation} onDone={() => setOpenId(null)} />}
          </div>
        )}
      </SidePanel>
    </>
  );
}
