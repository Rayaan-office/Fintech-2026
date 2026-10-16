import { SettingsIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/states";

export default function SettingsPage() {
  return (
    <div className="grid gap-6">
      <PageHeader title="Settings" />
      <EmptyState icon={SettingsIcon} title="Settings are on the way" description="Your profile, team, approval limits and the Pause AI switch will be managed here." />
    </div>
  );
}
