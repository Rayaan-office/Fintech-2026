import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useId, type ReactNode } from "react";
import { toast } from "sonner";
import { useCan, useCurrentUser } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useSetAiPaused } from "@/api/hooks";
import { Initials } from "@/components/Initials";
import { Section, Surface } from "@/components/kit";
import { Money } from "@/components/Money";
import { PageHeader } from "@/components/PageHeader";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { usePrivacy } from "@/lib/privacy";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { rolesText } from "@/shell/roles";

const THEMES: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "Device", icon: MonitorIcon },
];

function displayName(type: "region" | "currency", code: string): string {
  try {
    return new Intl.DisplayNames(["en-GB"], { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

export default function SettingsPage() {
  const me = useCurrentUser();
  const can = useCan();
  const { theme, setTheme } = useTheme();
  const privacy = usePrivacy();
  const pause = useSetAiPaused();
  const canPause = can("pause_ai");

  return (
    <div className="grid w-full max-w-2xl gap-8">
      <PageHeader title="Settings" />

      <Section title="Display">
        <Rows>
          <Row label="Theme">
            {(id) => (
              <RadioGroup.Root aria-labelledby={id} value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)} className="inline-flex h-9 items-center gap-1 rounded-full bg-muted p-1">
                {THEMES.map((t) => {
                  const Icon = t.icon;
                  return (
                    <RadioGroup.Item
                      key={t.value}
                      value={t.value}
                      title={t.value === "system" ? "Follow my device" : undefined}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=checked]:bg-card data-[state=checked]:text-foreground data-[state=checked]:shadow-card"
                    >
                      <Icon className="size-3.5" aria-hidden />
                      {t.label}
                    </RadioGroup.Item>
                  );
                })}
              </RadioGroup.Root>
            )}
          </Row>
          <Row label="Hide amounts" hint="Every amount shows as ••••">
            {(id) => <Switch aria-labelledby={id} checked={privacy.hidden} onCheckedChange={privacy.setHidden} />}
          </Row>
          <Row label="Keyboard shortcuts">
            {() => (
              <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                Press <Kbd>?</Kbd>
              </span>
            )}
          </Row>
        </Rows>
      </Section>

      <Section title="AI">
        <Rows>
          <Row label="Pause AI actions" hint={canPause ? "Everything waits for a person" : "Only owners can change this"}>
            {(id) => (
              <Switch
                aria-labelledby={id}
                checked={me.business.ai_paused}
                disabled={!canPause || pause.isPending}
                onCheckedChange={(paused) =>
                  pause.mutate(paused, {
                    onSuccess: (r) => toast.success(r.ai_paused ? "AI actions paused" : "AI actions back on"),
                    onError: (err) => toast.error(errorMessage(err)),
                  })
                }
              />
            )}
          </Row>
        </Rows>
      </Section>

      <Section title="Account">
        <Rows>
          <Row label="You">
            {() => (
              <span className="flex min-w-0 items-center gap-2.5 text-right">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{me.user.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{me.user.email}</span>
                </span>
                <Initials name={me.user.name} />
              </span>
            )}
          </Row>
          <Row label="Role">{() => <Value>{rolesText(me.user.roles)}</Value>}</Row>
          {me.approval_limit_minor != null && (
            <Row label="Approval limit">
              {() => (
                <Value>
                  <Money minor={me.approval_limit_minor!} currency={me.business.currency} />
                </Value>
              )}
            </Row>
          )}
          <Row label="Business">
            {() => (
              <span className="min-w-0 text-right">
                <span className="block truncate text-sm">{me.business.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {displayName("currency", me.business.currency)}, {displayName("region", me.business.country)}
                </span>
              </span>
            )}
          </Row>
        </Rows>
      </Section>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <Surface className="divide-y">{children}</Surface>;
}

/** One setting: its name on the left, the control or value on the right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: (labelId: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 px-4 py-2.5 sm:px-5">
      <div className="shrink-0">
        <div id={id} className="text-sm font-medium">
          {label}
        </div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex min-w-0 justify-end">{children(id)}</div>
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="truncate text-right text-sm">{children}</span>;
}
