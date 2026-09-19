import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}

/** Standard page header: bold title + description + action buttons. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("page-header", className)}>
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
