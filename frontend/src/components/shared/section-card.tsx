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
    <div className={cn(hover ? "card-base card-hover" : "card-base", className)}>
      {(title || action) && (
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="space-y-0.5">
            {title && <h3 className="text-[0.9375rem] font-semibold">{title}</h3>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </div>
  );
}
