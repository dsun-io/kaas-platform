"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { ArrowRight, Calculator, Database, Target } from "lucide-react";

export default function OnboardingPage() {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">新手引导</h1>
        <p className="text-muted-foreground mt-1">
          完成以下步骤，开始使用智能报价系统
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">
              1
            </div>
            <div>
              <CardTitle className="text-lg">确认主营丝网类型</CardTitle>
              <CardDescription>
                注册时已选择主营丝网大类，用于初始化报价模板方向。后续可在报价数据中自由添加任意具体产品（牛栏网、围栏、勾花网、刺绳、石笼网等），不受主营大类的限制。
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">
              2
            </div>
            <div>
              <CardTitle className="text-lg">录入规格与成本</CardTitle>
              <CardDescription>
                在报价数据页面录入您的产品规格和成本价。系统将基于您的数据生成报价，不会使用其他客户的数据。
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Link href="/pricing-data">
            <Button className="gap-2">
              <Database className="size-4" />
              去录入报价数据
              <ArrowRight className="size-4" />
            </Button>
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">
              3
            </div>
            <div>
              <CardTitle className="text-lg">开始智能报价</CardTitle>
              <CardDescription>
                数据就绪后，即可使用智能报价功能生成报价单和话术脚本。
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Link href="/quotations/v2-quote">
            <Button variant="outline" className="gap-2">
              <Calculator className="size-4" />
              智能报价
              <ArrowRight className="size-4" />
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
