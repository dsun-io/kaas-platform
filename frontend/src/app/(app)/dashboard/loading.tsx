import { Skeleton } from "@/components/ui/skeleton";

/**
 * 路由级加载骨架（服务端预取/首帧用）：与 M3 仪表盘结构一致 ——
 * 页头 + 四阶段漏斗 + 分渠道表 + 直接下单/应收两张卡。
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-full max-w-xl" />

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
