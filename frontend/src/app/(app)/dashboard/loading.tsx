import { PageHeader } from "@/components/shared/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 路由级加载骨架（服务端预取/首帧用）：与 M3 仪表盘结构一致 ——
 * 页头（真实 h1，加载态也有标题）+ 四阶段漏斗 + 分渠道表 + 直接下单/应收两张卡。
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="仪表盘"
        description="商机漏斗：按时间窗内创建的询盘看询盘→报价→下单→成笔的转化与渠道质量；直接下单单独统计。"
      />

      <div className="rounded-xl border p-5">
        <Skeleton className="h-5 w-24" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
      </div>

      <div className="rounded-xl border p-5">
        <Skeleton className="h-5 w-24" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}
