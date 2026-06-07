"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FileText, Search, Plus, ShieldAlert, ShieldCheck } from "lucide-react";

interface HeaderItem {
  id: number;
  company_name: string;
  tax_id: string;
  verification_status: string;
  is_primary: boolean;
  status: string;
}

export default function InvoiceHeadersPage() {
  const [search, setSearch] = useState("");
  const [headers] = useState<HeaderItem[]>([
    {
      id: 1,
      company_name: "示例科技有限公司",
      tax_id: "91110000MA00XXXX0X",
      verification_status: "verified",
      is_primary: true,
      status: "active",
    },
    {
      id: 2,
      company_name: "测试贸易中心",
      tax_id: "91110000MA00YYYY0Y",
      verification_status: "pending",
      is_primary: false,
      status: "active",
    },
  ]);

  const getVerificationBadge = (status: string) => {
    switch (status) {
      case "verified":
        return (
          <Badge variant="outline" className="text-green-600 border-green-200">
            <ShieldCheck className="size-3 mr-1" />
            已校验
          </Badge>
        );
      case "pending":
        return (
          <Badge variant="secondary">
            <ShieldAlert className="size-3 mr-1" />
            待校验
          </Badge>
        );
      case "failed":
        return <Badge variant="destructive">校验失败</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="size-6" />
            客户抬头管理
          </h1>
          <p className="text-muted-foreground mt-1">
            管理客户发票抬头，税务校验通过后才可用于开票
          </p>
        </div>
        <Button>
          <Plus className="size-4 mr-1" />
          新增抬头
        </Button>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="搜索公司名或税号..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-4">
        {headers.map((h) => (
          <Card key={h.id}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold">{h.company_name}</span>
                    {h.is_primary && <Badge>默认</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    税号：{h.tax_id}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {getVerificationBadge(h.verification_status)}
                  <Button size="sm" variant="outline">
                    编辑
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
