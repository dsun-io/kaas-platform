import { cn } from "@/lib/utils";

export type StatusTone = "default" | "success" | "warning" | "danger" | "info" | "purple";

const TONE_CLASSES: Record<StatusTone, string> = {
  default: "bg-secondary text-secondary-foreground",
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  danger: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  info: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400",
  purple: "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-400",
};

interface StatusBadgeProps {
  children: React.ReactNode;
  tone?: StatusTone;
  className?: string;
}

/**
 * Colored status badge with a dot indicator.
 * Used for stages, statuses, levels — any labelled state.
 */
export function StatusBadge({ children, tone = "default", className }: StatusBadgeProps) {
  return (
    <span className={cn("badge-dot", TONE_CLASSES[tone], className)}>
      {children}
    </span>
  );
}
