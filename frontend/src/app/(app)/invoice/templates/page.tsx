"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BookOpen, Plus, Search, TrendingUp } from "lucide-react";

interface TemplateItem {
  id: number;
  tax_code: string;
  tax_code_name: string;
  nickname: string;
  default_tax_rate: number;
  category?: string;
  usage_count: number;
  priority_score: number;
}

export default function InvoiceTemplatesPage() {
  const [search, setSearch] = useState("");
  const [templates] = useState<TemplateItem[]>([
    {
      id: 1,
      tax_code: "3040201020000000000",
      tax_code_name: "电线电缆",
      nickname: "电缆",
      default_tax_rate: 0.13,
      category: "电气设备",
      usage_count: 128,
      priority_score: 100,
    },
    {
      id: 2,
      tax_code: "3040201030000000000",
      tax_code_name: "配电柜",
      nickname: "配电箱",
      default_tax_rate: 0.13,
      category: "电气设备",
      usage_count: 56,
      priority_score: 80,
    },
  ]);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookOpen className="size-6" />
            开票模板库
          </h1>
          <p className="text-muted-foreground mt-1">
            管理商品税收分类编码，支持 AI 智能推荐
          </p>
        </div>
        <Button>
          <Plus className="size-4 mr-1" />
          新增模板
        </Button>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="搜索税码名称或别名..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-4">
        {templates.map((t) => (
          <Card key={t.id}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold">{t.nickname}</span>
                    <span className="text-sm text-muted-foreground">
                      ({t.tax_code_name})
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    税码：{t.tax_code} · 税率：
                    {(t.default_tax_rate * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <TrendingUp className="size-4" />
                    {t.usage_count} 次使用
                  </div>
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
