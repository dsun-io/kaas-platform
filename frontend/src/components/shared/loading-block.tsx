import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** 统一的数据区加载占位：替代“加载中…”纯文本。 */
export function LoadingBlock({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-2", className)}
      aria-busy="true"
      aria-label="加载中"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full rounded-md" />
      ))}
    </div>
  );
}
