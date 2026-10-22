import { PageHeader } from "@/components/shared/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** 路由级加载骨架：与「知识库管理」页结构一致（页头 + 统计卡 + 内容卡）。 */
export default function KbLoading() {
  return (
    <div className="space-y-6">
      <PageHeader title="知识库管理" description="产品知识与工位能力资料" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border p-4 space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-12" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border p-6">
        <Skeleton className="h-5 w-32 mb-4" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
