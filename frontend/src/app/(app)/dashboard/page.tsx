"use client";

import { Construction } from "lucide-react";

import { PageHeader } from "@/components/shared";
import { usePageView } from "@/lib/events/use-page-view";

/**
 * 仪表盘（契约状态 = `placeholder`）。
 *
 * 为什么不展示原来的 6 张卡（2026-10-21，C31）：
 * 契约 `shared/contracts/workstations.ts` 对 dashboard 的状态是 `placeholder`
 * ——「现有实现只展示系统运行指标（Token/延迟/采样率），对业务无用 → 改『更新中』」。
 * 而 `GET /dashboard/summary` 的 token/p95 在生产**恒为 0**（`main.py` 无真实采集源），
 * 把「没有数据」渲染成「0」比不显示更糟（见 AGENTS 规则 5 的口径）。所以这里
 * 如实改成占位，等新的业务指标口径落地再恢复卡片；旧实现留在这句注释里可追溯。
 */
export default function DashboardPage() {
  usePageView({ resource_id: "/dashboard" });

  return (
    <div className="space-y-8">
      <PageHeader title="仪表盘" description="业务指标改版中" />

      <section
        aria-label="仪表盘改版说明"
        className="rounded-xl border border-dashed p-10 text-center"
      >
        <Construction
          aria-hidden
          className="mx-auto mb-3 h-10 w-10 text-muted-foreground"
        />
        <p className="text-sm font-medium">仪表盘改版中</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          原有指标（Token 消耗、P95 延迟、采样覆盖率）对业务判断帮助有限，正在按新的
          业务口径重做。上线前请从侧栏各工位查看具体数据。
        </p>
      </section>
    </div>
  );
}
