import { type LucideIcon, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: { value: number; label?: string } | null;
  hint?: string;
  variant?: "default" | "gradient";
  className?: string;
}

/** Metric/stat card with icon, trend, and optional gradient accent. */
export function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  hint,
  variant = "default",
  className,
}: StatCardProps) {
  const trendUp = trend && trend.value >= 0;
  return (
    <div className={cn("stat-card animate-slide-up", className)}>
      {/* Subtle gradient background accent */}
      {variant === "gradient" && (
        <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: "var(--gradient-brand)" }} />
      )}

      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <p className="stat-label">{label}</p>
          <p className="stat-value">{value}</p>
        </div>
        {Icon && (
          <div className={variant === "gradient" ? "stat-icon-wrap" : "stat-icon-wrap-subtle"}>
            <Icon className="h-[18px] w-[18px]" />
          </div>
        )}
      </div>

      {(trend || hint) && (
        <div className="mt-3 flex items-center gap-2 text-xs">
          {trend && (
            <span className={trendUp ? "stat-trend-up" : "stat-trend-down"}>
              {trendUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {Math.abs(trend.value)}%
            </span>
          )}
          {hint && <span className="text-muted-foreground">{hint}</span>}
        </div>
      )}
    </div>
  );
}
