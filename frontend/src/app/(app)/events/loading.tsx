import { PageHeader } from "@/components/shared/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** 路由级加载骨架：与「事件审计」页结构一致（页头 + 筛选条 + 列表）。 */
export default function EventsLoading() {
  return (
    <div className="space-y-6">
      <PageHeader title="事件审计" description="系统事件与操作审计记录" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
