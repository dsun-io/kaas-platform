import { cn } from "@/lib/utils";

export type StatusTone = "default" | "success" | "warning" | "danger" | "info" | "purple";

const TONE_CLASSES: Record<StatusTone, string> = {
  default: "badge-default",
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  info: "badge-info",
  purple: "badge-purple",
};

interface StatusBadgeProps {
  children: React.ReactNode;
  tone?: StatusTone;
  dot?: boolean;
  className?: string;
}

/** Colored status badge with optional dot indicator. */
export function StatusBadge({ children, tone = "default", dot = true, className }: StatusBadgeProps) {
  return (
    <span className={cn("badge", dot && "badge-dot", TONE_CLASSES[tone], className)}>
      {children}
    </span>
  );
}
