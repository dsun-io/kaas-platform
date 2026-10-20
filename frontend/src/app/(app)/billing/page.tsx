"use client";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { CreditCard } from "lucide-react";
import { PageHeader } from "@/components/shared";

export default function BillingPage() {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-2xl mx-auto">
      <PageHeader title="升级订阅" description="管理您的订阅计划" />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CreditCard className="size-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-lg">当前方案：免费版</CardTitle>
              <CardDescription>
                订阅升级功能即将开放，请联系管理员。
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            升级后可解锁更多报价模板、批量导入、API
            对接等高级功能。如有需要，请先联系系统管理员开通。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
