"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { Quotation } from "../hooks/use-quotations";

interface Props {
  quotation: Quotation | null;
  onClose: () => void;
}

export function QuotationDetailSheet({ quotation, onClose }: Props) {
  return (
    <Sheet open={!!quotation} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-auto">
        {quotation && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-sm">
                {quotation.quotation_id}
              </SheetTitle>
            </SheetHeader>
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge>{quotation.product_category}</Badge>
                <Badge variant="outline">{quotation.source}</Badge>
                <Badge
                  variant={
                    quotation.status === "estimated"
                      ? "destructive"
                      : quotation.status === "spec_not_supported"
                        ? "secondary"
                        : "default"
                  }
                >
                  {quotation.status}
                </Badge>
                <Badge variant="outline">{quotation.confidence}</Badge>
              </div>
              <Separator />
              <dl className="space-y-2 text-sm">
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">客户</dt>
                  <dd>{quotation.customer_id}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">数量</dt>
                  <dd>{quotation.quantity}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">单价</dt>
                  <dd>
                    {quotation.unit_price != null
                      ? `¥${quotation.unit_price.toFixed(2)}`
                      : "—"}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">折扣</dt>
                  <dd>{quotation.discount}%</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">
                    有效期
                  </dt>
                  <dd>
                    {new Date(quotation.effective_from).toLocaleString("zh-CN")}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">hash</dt>
                  <dd className="font-mono text-xs">{quotation.spec_hash}</dd>
                </div>
                {quotation.notes && (
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-muted-foreground">
                      备注
                    </dt>
                    <dd>{quotation.notes}</dd>
                  </div>
                )}
              </dl>
              <Separator />
              <div>
                <h4 className="mb-2 text-sm font-medium">产品规格</h4>
                <pre className="max-h-48 overflow-auto rounded bg-muted p-3 text-xs">
                  {JSON.stringify(quotation.product_spec, null, 2)}
                </pre>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
