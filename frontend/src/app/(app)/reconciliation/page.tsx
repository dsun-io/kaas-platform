"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Calculator,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  FileSpreadsheet,
} from "lucide-react";

interface PlatformOrder {
  id: number;
  platform: string;
  order_id: string;
  sku: string;
  quantity: number;
  amount: string;
  order_date: string;
}

interface LogisticsBill {
  id: number;
  provider: string;
  bill_no: string;
  order_ids: string[];
  freight_fee: string;
  bill_date: string;
}

export default function ReconciliationPage() {
  const [activeTab, setActiveTab] = useState("overview");

  const platformOrders: PlatformOrder[] = [
    {
      id: 1,
      platform: "淘宝",
      order_id: "TB20260523001",
      sku: "SKU-A001",
      quantity: 10,
      amount: "¥5,000.00",
      order_date: "2026-05-20",
    },
    {
      id: 2,
      platform: "京东",
      order_id: "JD20260523002",
      sku: "SKU-A002",
      quantity: 5,
      amount: "¥2,500.00",
      order_date: "2026-05-21",
    },
    {
      id: 3,
      platform: "拼多多",
      order_id: "PDD20260523003",
      sku: "SKU-A003",
      quantity: 20,
      amount: "¥8,000.00",
      order_date: "2026-05-22",
    },
  ];

  const logisticsBills: LogisticsBill[] = [
    {
      id: 1,
      provider: "顺丰",
      bill_no: "SF202605001",
      order_ids: ["TB20260523001", "JD20260523002"],
      freight_fee: "¥150.00",
      bill_date: "2026-05-22",
    },
    {
      id: 2,
      provider: "中通",
      bill_no: "ZT202605002",
      order_ids: ["PDD20260523003"],
      freight_fee: "¥80.00",
      bill_date: "2026-05-23",
    },
  ];

  const totalPlatformQty = platformOrders.reduce(
    (sum, o) => sum + o.quantity,
    0,
  );
  const totalLogisticsOrders = logisticsBills.reduce(
    (sum, b) => sum + b.order_ids.length,
    0,
  );
  const isBalanced = totalPlatformQty === totalLogisticsOrders;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Calculator className="size-6" />
            电商对账中心
          </h1>
          <p className="text-muted-foreground mt-1">
            多平台订单 vs 物流商账单，自动匹配与差异分析
          </p>
        </div>
        <Button>
          <RefreshCw className="size-4 mr-1" />
          开始对账
        </Button>
      </div>

      {/* 汇总卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">平台订单总数</p>
            <p className="text-2xl font-bold">{totalPlatformQty}</p>
            <p className="text-xs text-muted-foreground">来自 3 个平台</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">物流账单订单数</p>
            <p className="text-2xl font-bold">{totalLogisticsOrders}</p>
            <p className="text-xs text-muted-foreground">来自 2 家物流商</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">对账状态</p>
            <div className="flex items-center gap-2 mt-1">
              {isBalanced ? (
                <>
                  <CheckCircle className="size-6 text-green-600" />
                  <span className="text-lg font-bold text-green-600">平衡</span>
                </>
              ) : (
                <>
                  <AlertCircle className="size-6 text-red-600" />
                  <span className="text-lg font-bold text-red-600">差异</span>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">总览</TabsTrigger>
          <TabsTrigger value="platforms">平台订单</TabsTrigger>
          <TabsTrigger value="logistics">物流账单</TabsTrigger>
          <TabsTrigger value="diff">差异分析</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileSpreadsheet className="size-5" />
                对账概览
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                核心对账公式：3 个平台对账表格中的数据数量之和 = 3
                个物流商账单所有订单数据数量之和
              </p>
              <div className="mt-4 p-4 bg-muted rounded-lg">
                <code className="text-sm">
                  Σ(平台订单数量) = {totalPlatformQty}　·　Σ(物流账单订单数) ={" "}
                  {totalLogisticsOrders}
                </code>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="platforms" className="mt-4">
          <div className="grid gap-4">
            {platformOrders.map((o) => (
              <Card key={o.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Badge>{o.platform}</Badge>
                        <span className="font-medium">{o.order_id}</span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        SKU: {o.sku} · 数量: {o.quantity} · 日期: {o.order_date}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">{o.amount}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="logistics" className="mt-4">
          <div className="grid gap-4">
            {logisticsBills.map((b) => (
              <Card key={b.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline">{b.provider}</Badge>
                        <span className="font-medium">{b.bill_no}</span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        关联订单: {b.order_ids.join(", ")} · 日期: {b.bill_date}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">{b.freight_fee}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="diff" className="mt-4">
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <AlertCircle className="size-12 mx-auto mb-4 opacity-50" />
              <p>差异分析功能开发中，将展示订单级别的匹配与差异明细</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
