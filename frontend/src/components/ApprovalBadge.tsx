import { EyeIcon, LightbulbIcon, PencilLineIcon, SendIcon, UsersIcon, type LucideIcon } from "lucide-react";
import type { ApprovalLevel } from "@/api/types";
import { cn } from "@/lib/utils";
import { Badge, type BadgeProps } from "./ui/badge";

type LevelInfo = { label: string; icon: LucideIcon; description: string; variant: BadgeProps["variant"] };

export const APPROVAL_LEVELS: Record<ApprovalLevel, LevelInfo> = {
  0: { label: "Read", icon: EyeIcon, description: "Only looks at your records. Nothing changes.", variant: "outline" },
  1: { label: "Suggest", icon: LightbulbIcon, description: "A suggestion that waits for a person to check.", variant: "outline" },
  2: { label: "Small change", icon: PencilLineIcon, description: "A small change to your records that can be undone.", variant: "neutral" },
  3: { label: "Outside action", icon: SendIcon, description: "Reaches outside the app, so one person must approve.", variant: "accent" },
  4: { label: "Two people", icon: UsersIcon, description: "High risk, so two different people must approve.", variant: "warning" },
};

export function ApprovalBadge({ level, className }: { level: ApprovalLevel; className?: string }) {
  const info = APPROVAL_LEVELS[level];
  const Icon = info.icon;
  return (
    <Badge
      variant={info.variant}
      className={cn("font-medium", className)}
      title={`Level ${level}: ${info.description}`}
      aria-label={`Approval level ${level}: ${info.label}`}
      data-level={level}
    >
      <Icon aria-hidden />
      {info.label}
    </Badge>
  );
}
