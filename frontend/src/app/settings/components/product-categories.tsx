'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

const DEFAULT_CATEGORIES = ['牛栏网', '石笼网', '镀锌', '包塑', '立柱'];

export function ProductCategories() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>产品分类配置</CardTitle>
        <CardDescription>
          当前租户可用的产品分类（只读，编辑功能将后续开放）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {DEFAULT_CATEGORIES.map((cat) => (
            <Badge key={cat} variant="secondary" className="text-sm px-3 py-1">
              {cat}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
