"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

/**
 * 调研产品表格 + 分页（从 page.tsx 拆出；列顺序/th scope/行内按钮 aria/空态文案不变）。
 *
 * 行内动作（深化 / 移除）回调给页面；`PaginationBar` 的位置也与原先一致
 * （空态时同样渲染 —— 这是既有行为，测试按此断言）。
 */
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { ImageOff, PackageSearch, Pencil, Trash2 } from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";

import { RESEARCH_PAGE_SIZE } from "../lib/constants";
import type { ResearchProduct } from "../lib/types";

function supplyBadge(v: boolean | null) {
  if (v === true) return <StatusBadge tone="success">可供货</StatusBadge>;
  if (v === false) return <StatusBadge tone="danger">不可供货</StatusBadge>;
  return <StatusBadge tone="default">未填</StatusBadge>;
}

export function ResearchProductsTable({
  products,
  total,
  page,
  isFetching,
  onPageChange,
  onEdit,
  onDelete,
}: {
  products: ResearchProduct[];
  total: number;
  page: number;
  isFetching: boolean;
  onPageChange: (page: number) => void;
  onEdit: (product: ResearchProduct, opener?: HTMLElement | null) => void;
  onDelete: (product: ResearchProduct) => void;
}) {
  return (
    <>
      {products.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="暂无调研产品"
          description="到「从地图源挑选」选择值得深化的线索"
        />
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="border-b text-left text-xs text-muted-foreground">
                <TableHead scope="col" className="p-2">
                  图片
                </TableHead>
                <TableHead scope="col" className="p-2">
                  产品（本地 / 中文）
                </TableHead>
                <TableHead scope="col" className="p-2">
                  规格
                </TableHead>
                <TableHead scope="col" className="p-2">
                  地区
                </TableHead>
                <TableHead scope="col" className="p-2">
                  店铺
                </TableHead>
                <TableHead scope="col" className="p-2">
                  联系方式
                </TableHead>
                <TableHead scope="col" className="p-2">
                  价格
                </TableHead>
                <TableHead scope="col" className="p-2">
                  可供货
                </TableHead>
                <TableHead scope="col" className="p-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id} className="border-b hover:bg-muted/40">
                  <TableCell className="p-2">
                    {p.product_image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.product_image_url}
                        alt={p.product_name ?? "产品"}
                        className="h-12 w-12 rounded object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded bg-secondary">
                        <ImageOff className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="p-2">
                    <div className="font-medium">{p.product_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.product_name_cn ?? "—"}
                    </div>
                  </TableCell>
                  <TableCell className="p-2 max-w-[220px] truncate text-xs text-muted-foreground">
                    {p.spec_raw ?? "—"}
                  </TableCell>
                  <TableCell className="p-2 text-xs">
                    {[p.country, p.city].filter(Boolean).join(" / ") || "—"}
                  </TableCell>
                  <TableCell className="p-2 text-xs">
                    <div>{p.shop_name ?? "—"}</div>
                    <div className="text-muted-foreground">
                      {p.shop_type ?? ""}
                    </div>
                  </TableCell>
                  <TableCell className="p-2 text-xs">
                    <div>{p.phone ?? "—"}</div>
                    {p.website && (
                      <a
                        className="text-primary hover:underline"
                        href={p.website}
                        target="_blank"
                        rel="noreferrer"
                      >
                        官网
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="p-2 text-xs">
                    {p.price_local != null
                      ? `${p.price_local} ${p.price_currency ?? ""}`
                      : "—"}
                  </TableCell>
                  <TableCell className="p-2">
                    {supplyBadge(p.can_supply)}
                  </TableCell>
                  <TableCell className="p-2">
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => onEdit(p, e.currentTarget)}
                        title="深化"
                        aria-label={`深化产品 ${p.product_name ?? p.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDelete(p)}
                        title="移除"
                        aria-label={`移除产品 ${p.product_name ?? p.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <PaginationBar
        page={page}
        pageSize={RESEARCH_PAGE_SIZE}
        total={total}
        currentCount={products.length}
        loading={isFetching}
        onPageChange={onPageChange}
        ariaLabel="调研产品分页"
      />
    </>
  );
}
