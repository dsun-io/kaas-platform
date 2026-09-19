import { type LucideIcon, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: { value: number; label?: string } | null;
  hint?: string;
  className?: string;
}

/**
 * Reusable stat/metric card for dashboards and summary rows.
 * Replaces the old StatCard with a cleaner, brand-consistent design.
 */
export function StatCard({ label, value, icon: Icon, trend, hint, className }: StatCardProps) {
  const trendUp = trend && trend.value >= 0;
  return (
    <Card className={cn("card-hover", className)}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="stat-label">{label}</p>
            <p className="stat-value">{value}</p>
          </div>
          {Icon && (
            <div className="rounded-lg bg-accent p-2.5 text-accent-foreground">
              <Icon className="h-4 w-4" />
            </div>
          )}
        </div>
        {(trend || hint) && (
          <div className="mt-3 flex items-center gap-2 text-xs">
            {trend && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 font-medium",
                  trendUp ? "text-emerald-600" : "text-red-600"
                )}
              >
                {trendUp ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {Math.abs(trend.value)}%
              </span>
            )}
            {hint && <span className="text-muted-foreground">{hint}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
