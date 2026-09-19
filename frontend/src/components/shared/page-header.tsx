import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}

/**
 * Standard page header used across all pages.
 * Future pages automatically get consistent title/description/action layout.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("page-header", className)}>
      <div className="min-w-0">
        <h1 className="page-header-title">{title}</h1>
        {description && <p className="page-header-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
