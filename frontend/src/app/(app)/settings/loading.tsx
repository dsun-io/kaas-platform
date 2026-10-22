import { PageHeader } from "@/components/shared/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** 路由级加载骨架：与「系统设置」页结构一致（页头 + 空间/账号卡片）。 */
export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeader title="系统设置" description="空间、平台账号与系统操作" />
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
