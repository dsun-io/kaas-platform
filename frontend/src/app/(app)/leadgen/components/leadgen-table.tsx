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
 * 线索池表格（从 page.tsx 拆出，DOM/列顺序/aria 不变）。
 * 行为回调（打开详情 / 单行爬取）仍由页面持有。
 */
import { Button } from "@/components/ui/button";
import { EmptyState, StatusBadge } from "@/components/shared";
import {
  CRAWL_STATUS_TONES,
  OUTREACH_STATUS_TONES,
  scoreTone,
  toneForStatus,
} from "@/lib/status-tones";
import { Globe, ImageOff } from "lucide-react";

import { CRAWL_STATUS_CN, OUTREACH_STATUS_CN } from "../lib/status-labels";
import type { Lead } from "../lib/types";

function supplyCell(v: boolean | null) {
  if (v === true) return <StatusBadge tone="success">是</StatusBadge>;
  if (v === false) return <StatusBadge tone="danger">否</StatusBadge>;
  return <span className="text-xs text-muted-foreground">—</span>;
}

export function LeadgenTable({
  leads,
  crawling,
  detailPending,
  detailId,
  onCrawlOne,
  onOpenDetail,
}: {
  leads: Lead[];
  /** 单行爬取进行中的线索 id（null = 空闲；非 null 时所有爬取按钮禁用） */
  crawling: number | null;
  /** 详情请求进行中（行级 pending 只作用于当前行） */
  detailPending: boolean;
  detailId: number | null;
  onCrawlOne: (id: number) => void;
  onOpenDetail: (id: number, opener?: HTMLElement | null) => void;
}) {
  if (leads.length === 0) {
    return (
      <EmptyState title="暂无线索" description="先运行一次抓取来填充线索池" />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <TableHeader>
          <TableRow className="border-b text-left text-muted-foreground">
            <TableHead scope="col" className="p-2">
              图片
            </TableHead>
            <TableHead scope="col" className="p-2">
              公司
            </TableHead>
            <TableHead scope="col" className="p-2">
              地区
            </TableHead>
            <TableHead scope="col" className="p-2">
              店铺类型
            </TableHead>
            <TableHead scope="col" className="p-2">
              产品（本地 / 中文）
            </TableHead>
            <TableHead scope="col" className="p-2">
              规格
            </TableHead>
            <TableHead scope="col" className="p-2">
              爬取
            </TableHead>
            <TableHead scope="col" className="p-2">
              可供货
            </TableHead>
            <TableHead scope="col" className="p-2">
              评分
            </TableHead>
            <TableHead scope="col" className="p-2">
              触达
            </TableHead>
            <TableHead scope="col" className="p-2" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {leads.map((l) => (
            <TableRow key={l.id} className="border-b hover:bg-muted/40">
              <TableCell className="p-2">
                {l.product_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={l.product_image_url}
                    alt={l.product_name ?? "产品"}
                    className="h-10 w-10 rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded bg-secondary">
                    <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                )}
              </TableCell>
              <TableCell className="p-2">
                <div className="font-medium">{l.company_name}</div>
                <div className="text-xs text-muted-foreground">
                  {l.email ?? "—"}
                </div>
              </TableCell>
              <TableCell className="p-2 text-xs">
                {[l.city, l.region, l.country].filter(Boolean).join(", ") ||
                  "—"}
              </TableCell>
              <TableCell className="p-2 text-xs">
                {l.shop_type ?? l.industry ?? "—"}
              </TableCell>
              <TableCell className="p-2 text-xs">
                <div>{l.product_name ?? "—"}</div>
                <div className="text-muted-foreground">
                  {l.product_name_cn ?? ""}
                </div>
              </TableCell>
              <TableCell className="p-2 max-w-[180px] truncate text-xs text-muted-foreground">
                {l.spec_raw ?? "—"}
              </TableCell>
              <TableCell className="p-2">
                <div className="flex items-center gap-1">
                  <StatusBadge
                    tone={toneForStatus(CRAWL_STATUS_TONES, l.crawl_status)}
                  >
                    {CRAWL_STATUS_CN[l.crawl_status ?? "pending"] ??
                      l.crawl_status ??
                      "pending"}
                  </StatusBadge>
                  {(l.crawl_status === "pending" ||
                    l.crawl_status === "failed") &&
                    l.website && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="爬取官网获取产品信息"
                        disabled={crawling !== null}
                        onClick={() => onCrawlOne(l.id)}
                      >
                        <Globe className="h-4 w-4" />
                      </Button>
                    )}
                </div>
              </TableCell>
              <TableCell className="p-2">{supplyCell(l.can_supply)}</TableCell>
              <TableCell className="p-2">
                <StatusBadge tone={scoreTone(l.fit_score)}>
                  {l.fit_score ?? "—"}
                </StatusBadge>
              </TableCell>
              <TableCell className="p-2">
                <StatusBadge
                  tone={toneForStatus(OUTREACH_STATUS_TONES, l.outreach_status)}
                >
                  {OUTREACH_STATUS_CN[l.outreach_status] ?? l.outreach_status}
                </StatusBadge>
              </TableCell>
              <TableCell className="p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => onOpenDetail(l.id, e.currentTarget)}
                  disabled={detailPending && detailId === l.id}
                >
                  {detailPending && detailId === l.id ? "加载中…" : "详情"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
