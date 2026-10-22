import { PageHeader } from "@/components/shared/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** 路由级加载骨架：与「灰度发布」页结构一致（页头 + 开关区 + 审计卡）。 */
export default function GrayReleaseLoading() {
  return (
    <div className="space-y-6">
      <PageHeader title="灰度发布" description="灰度开关与发布审计" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
