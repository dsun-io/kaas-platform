"use client";

/**
 * 线索详情抽屉（从 page.tsx 拆出，U-P0B6/X2 的 DetailDrawer 结构不变）。
 *
 * 只有展示与「爬取 / 可供货判定」两个动作；数据请求与 pending/error 由页面持有
 * （页面仍是「状态编排 + 数据 hooks」那一层）。
 */
import { Button } from "@/components/ui/button";
import { DetailDrawer, ErrorState, StatusBadge } from "@/components/shared";
import { LoadingBlock } from "@/components/shared/loading-block";
import {
  CRAWL_STATUS_TONES,
  INQUIRY_STATUS_TONES,
  OUTREACH_STATUS_TONES,
  toneForStatus,
} from "@/lib/status-tones";
import { CheckCircle2, Globe, ImageOff, XCircle } from "lucide-react";

import {
  CRAWL_STATUS_CN,
  INQUIRY_STATUS_CN,
  OUTREACH_STATUS_CN,
} from "../lib/status-labels";
import type { LeadDetail } from "../lib/types";

export function LeadgenDetailDrawer({
  open,
  detail,
  pending,
  error,
  onRetry,
  onClose,
  crawling,
  onCrawl,
  onSetSupply,
}: {
  open: boolean;
  detail: LeadDetail | null;
  /** 详情请求进行中 */
  pending: boolean;
  /** 详情请求失败原因（已归一化） */
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
  /** 单行爬取进行中的线索 id（null = 空闲） */
  crawling: number | null;
  onCrawl: (id: number) => void;
  onSetSupply: (id: number, value: boolean | null) => void;
}) {
  return (
    <DetailDrawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={detail?.company_name ?? "线索详情"}
      description={
        detail
          ? `${detail.country ?? "—"}${detail.city ? ` · ${detail.city}` : ""} · 线索 #${detail.id}`
          : "正在加载…"
      }
      footer={
        <Button variant="outline" size="sm" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {pending && !detail ? <LoadingBlock rows={5} /> : null}
      {error ? (
        <ErrorState
          title="线索详情加载失败"
          message={error}
          onRetry={onRetry}
        />
      ) : null}
      {detail && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
            <div>
              <span className="text-muted-foreground">官网：</span>{" "}
              {detail.website ? (
                <a
                  className="text-blue-600 underline"
                  href={detail.website}
                  target="_blank"
                  rel="noreferrer"
                >
                  {detail.website}
                </a>
              ) : (
                "—"
              )}
            </div>
            <div>
              <span className="text-muted-foreground">电话：</span>{" "}
              {detail.phone ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">店铺类型：</span>{" "}
              {detail.shop_type ?? detail.industry ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Google 评分：</span>{" "}
              {detail.google_rating ?? "—"} (共{" "}
              {detail.google_reviews ?? 0} 条评价)
            </div>
            <div>
              <span className="text-muted-foreground">匹配理由：</span>{" "}
              {(detail.fit_reasons ?? []).join(", ") || "—"}
            </div>
          </div>

          {/* 产品信息（爬官网）：Google Places 拿不到产品 */}
          <div className="mt-4 rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold">
                产品信息（来自官网爬取）
              </h4>
              <div className="flex items-center gap-2">
                <StatusBadge
                  tone={toneForStatus(
                    CRAWL_STATUS_TONES,
                    detail.crawl_status,
                  )}
                >
                  {CRAWL_STATUS_CN[detail.crawl_status ?? "pending"] ??
                    detail.crawl_status ??
                    "pending"}
                </StatusBadge>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={crawling !== null}
                  onClick={() => onCrawl(detail.id)}
                >
                  <Globe className="mr-1 h-4 w-4" /> 爬取
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                {detail.product_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={detail.product_image_url}
                    alt={detail.product_name ?? "product"}
                    className="h-28 w-28 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-28 w-28 items-center justify-center rounded bg-secondary">
                    <ImageOff className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="md:col-span-3 space-y-1 text-sm">
                <div>
                  <span className="text-muted-foreground">本地名称：</span>{" "}
                  {detail.product_name ?? "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">中文名称：</span>{" "}
                  {detail.product_name_cn ?? "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">规格：</span>{" "}
                  {detail.spec_raw ?? "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">链接：</span>{" "}
                  {detail.link_url ? (
                    <a
                      className="text-blue-600 underline"
                      href={detail.link_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开
                    </a>
                  ) : (
                    "—"
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    可供货（由你判定）：
                  </span>
                  <Button
                    variant={detail.can_supply === true ? "default" : "outline"}
                    size="sm"
                    onClick={() => onSetSupply(detail.id, true)}
                  >
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> 是
                  </Button>
                  <Button
                    variant={detail.can_supply === false ? "default" : "outline"}
                    size="sm"
                    onClick={() => onSetSupply(detail.id, false)}
                  >
                    <XCircle className="mr-1 h-3.5 w-3.5" /> 否
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onSetSupply(detail.id, null)}
                  >
                    清除
                  </Button>
                </div>
              </div>
            </div>
          </div>
          {detail.opening_line && (
            <div className="mt-3 rounded bg-muted p-2 text-sm italic">
              “{detail.opening_line}”
            </div>
          )}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                触达历史（只读，由触达工位维护）
              </div>
              {detail.outreach_history.length === 0 ? (
                <div className="text-xs text-muted-foreground">无</div>
              ) : (
                detail.outreach_history.map((m) => (
                  <div key={m.id} className="flex gap-2 text-xs">
                    <StatusBadge
                      tone={toneForStatus(OUTREACH_STATUS_TONES, m.status)}
                    >
                      {OUTREACH_STATUS_CN[m.status] ?? m.status}
                    </StatusBadge>
                    <span className="text-muted-foreground">
                      {m.sent_at?.slice(0, 19) ?? ""}
                    </span>
                    {m.error && (
                      <span className="text-destructive">{m.error}</span>
                    )}
                  </div>
                ))
              )}
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                询盘历史（只读，由询盘工位维护）
              </div>
              {detail.inquiry_history.length === 0 ? (
                <div className="text-xs text-muted-foreground">无</div>
              ) : (
                detail.inquiry_history.map((i) => (
                  <div key={i.id} className="flex gap-2 text-xs">
                    <StatusBadge
                      tone={toneForStatus(INQUIRY_STATUS_TONES, i.status)}
                    >
                      {INQUIRY_STATUS_CN[i.status] ?? i.status}
                    </StatusBadge>
                    <span className="text-muted-foreground">
                      询盘 #{i.id} · {i.created_at.slice(0, 19)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            线索池里的评分与联系方式可在此页维护；触达与询盘状态由对应工位自动回写。
          </p>
        </div>
      )}
    </DetailDrawer>
  );
}
