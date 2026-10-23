"use client";

/**
 * 客户管理工位（/customers）—— 页面壳：状态编排 + 列表 + 详情挂载。
 *
 * U-P1D2 拆分（行为/DOM/aria/测试全部不变）：
 * · 类型与阶段常量 → `components/customer-types.ts`
 * · 列表/详情查询 → `hooks/use-customers.ts`
 * · 新建/编辑客户表单 → `components/customer-form.tsx`
 * · 联系人表单 + 联系人信息弹窗 → `components/contact-form.tsx`
 * · 更新阶段 / 删除客户 → `components/customer-detail-dialogs.tsx`
 * · 客户详情（Dialog + 三个 tab）→ `components/customer-detail-panel.tsx`
 * · 询盘详情抽屉早已独立（`inquiry-detail-drawer.tsx`），未重复拆。
 */
import { useEffect, useRef, useState } from "react";
import { Search, UserPlus, ChevronRight } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, StatusBadge, EmptyState } from "@/components/shared";
import { PaginationBar } from "@/components/shared/pagination-bar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePageView } from "@/lib/events/use-page-view";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

import { CustomerDetailPanel } from "./components/customer-detail-panel";
import { CustomerForm } from "./components/customer-form";
import {
  CUSTOMER_STAGE_FILTER_OPTIONS,
  STAGE_LABELS,
  STAGE_TONES,
  stageLabel,
  type Customer,
} from "./components/customer-types";
import { CUSTOMERS_PAGE_SIZE, useCustomerList } from "./hooks/use-customers";

export default function CustomersPage() {
  usePageView({ resource_id: "/customers" });
  const [searchQ, setSearchQ] = useState("");
  // 客户阶段筛选（C35）：值域 = 后端 `stage` 查询参数（active/inactive/ordered）；
  // "all" 只是前端哨兵（base-ui Select 不接受空串 value），不发给后端。
  const [stageFilter, setStageFilter] = useState<string>("all");
  const searchRef = useRef<HTMLInputElement>(null);
  // 快捷键：/ 聚焦搜索，Esc 退出搜索（输入框内不劫持）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (
        e.key === "Escape" &&
        document.activeElement === searchRef.current
      ) {
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(
    null,
  );

  // 列表分页（后端 page/page_size；筛选/搜索变化回第 1 页）
  const [page, setPage] = useState(1);
  // C5：搜索防抖（300ms）—— 输入即时回显，停止输入后才发请求
  const debouncedSearchQ = useDebouncedValue(searchQ, 300);
  const { data: listData, isLoading } = useCustomerList(
    debouncedSearchQ || undefined,
    stageFilter === "all" ? undefined : stageFilter,
    page,
  );

  // 权限口径（UNCERTAIN #21）：所有登录用户可用业务客户管理，
  // 团队隔离由后端 _scope_filter 保证；登录态由布局层 AuthGate 统一管。
  return (
    <div className="space-y-6">
      <PageHeader
        title="客户管理"
        description="跟进询盘、阶段与联系人"
        actions={
          <Button onClick={() => setShowCreateForm(true)}>
            <UserPlus className="size-4 mr-1" />
            新建客户
          </Button>
        }
      />

      {showCreateForm && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>新建客户</CardTitle>
          </CardHeader>
          <CardContent>
            <CustomerForm
              onClose={() => setShowCreateForm(false)}
              onCreated={setSelectedCustomer}
            />
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden rounded-2xl border-white/70 bg-white/80 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_16px_40px_-24px_rgba(23,30,60,0.18)] backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-4">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              placeholder="搜索客户…（按 / 聚焦）"
              aria-keyshortcuts="/"
              value={searchQ}
              onChange={(e) => {
                setSearchQ(e.target.value);
                setPage(1); // 搜索变化回第 1 页
              }}
              className="h-9 rounded-full border-white/70 bg-white/80 pl-9"
            />
          </div>
          <Select
            value={stageFilter}
            onValueChange={(value) => {
              setStageFilter(value ?? "all");
              setPage(1); // 阶段筛选变化回第 1 页
            }}
          >
            <SelectTrigger
              aria-label="客户阶段筛选"
              className="h-9 w-[132px] rounded-full border-white/70 bg-white/80"
            >
              <SelectValue placeholder="全部阶段" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部阶段</SelectItem>
              {CUSTOMER_STAGE_FILTER_OPTIONS.map((stage) => (
                <SelectItem key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto text-xs text-muted-foreground">
            {/* C6：计数用后端 total（items 只是当前页；用 items.length 会少报） */}
            共 {listData?.total ?? 0} 家客户
          </div>
        </div>

        {isLoading ? (
          <div>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b border-border/60 px-5 py-4 last:border-0"
              >
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="ml-auto h-5 w-14 rounded-full" />
              </div>
            ))}
          </div>
        ) : listData?.items?.length === 0 ? (
          <div className="px-6 py-14">
            <EmptyState
              title={stageFilter === "all" ? "暂无客户" : "没有符合筛选的客户"}
              description={
                stageFilter === "all"
                  ? "新建第一个客户后，这里会显示跟进阶段与联系方式。"
                  : `当前筛选（${STAGE_LABELS[stageFilter] ?? stageFilter}）下没有客户，可切换阶段或清除筛选。`
              }
              action={
                stageFilter === "all" ? (
                  <Button onClick={() => setShowCreateForm(true)}>
                    <UserPlus className="mr-1 size-4" />
                    新建客户
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => setStageFilter("all")}
                  >
                    清除阶段筛选
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70 bg-white/50 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-5 py-3 font-medium">
                      客户
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      国家 · 港口
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      阶段
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      最近更新
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-right font-medium"
                    >
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {listData?.items?.map((c) => (
                    <tr
                      key={c.id}
                      data-testid="customer-card"
                      tabIndex={0}
                      aria-label={`查看客户 ${c.company_name}`}
                      className="group cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
                      onClick={() => setSelectedCustomer(c)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedCustomer(c);
                        }
                      }}
                    >
                      <td className="px-5 py-3.5">
                        <p className="font-medium text-foreground">
                          {c.company_name}
                        </p>
                        {c.abbr && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {c.abbr}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-muted-foreground">
                        {[c.country, c.default_port]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                      <td className="px-4 py-3.5">
                        <StatusBadge tone={STAGE_TONES[c.stage] ?? "default"}>
                          {stageLabel(c.stage)}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-3.5 text-muted-foreground">
                        {new Date(c.updated_at).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <ChevronRight className="ml-auto size-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 窄屏卡片：DOM 放在表格之后，避免 e2e 的 getByText().first() 命中山卡隐藏节点 */}
            <div className="divide-y divide-border/60 md:hidden">
              {listData?.items?.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-label={`查看客户 ${c.company_name}`}
                  className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
                  onClick={() => setSelectedCustomer(c)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {c.company_name}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[c.country, c.default_port]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StatusBadge tone={STAGE_TONES[c.stage] ?? "default"}>
                        {stageLabel(c.stage)}
                      </StatusBadge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(c.updated_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
                </button>
              ))}
            </div>
          </>
        )}
        <PaginationBar
          page={page}
          pageSize={CUSTOMERS_PAGE_SIZE}
          total={listData?.total ?? 0}
          currentCount={listData?.items?.length ?? 0}
          loading={isLoading}
          onPageChange={setPage}
          ariaLabel="客户列表分页"
          className="px-5 pb-4"
        />
      </Card>

      {selectedCustomer && (
        <div className="mt-2">
          <CustomerDetailPanel
            customer={selectedCustomer}
            onClose={() => setSelectedCustomer(null)}
            onUpdated={setSelectedCustomer}
          />
        </div>
      )}
    </div>
  );
}
