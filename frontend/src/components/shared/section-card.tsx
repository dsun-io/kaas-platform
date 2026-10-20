import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionCardProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  hover?: boolean;
}

/** Standard content section: title + optional action + body. */
export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
  hover = false,
}: SectionCardProps) {
  return (
    <div
      className={cn(hover ? "card-base card-hover" : "card-base", className)}
    >
      {(title || action) && (
        <div className="flex flex-col items-start gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            {title && (
              <h3 className="text-[0.9375rem] font-semibold">{title}</h3>
            )}
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action && <div className="w-full sm:w-auto">{action}</div>}
        </div>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </div>
  );
}
