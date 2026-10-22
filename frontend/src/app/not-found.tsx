import Link from "next/link";

import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";

/**
 * 全局 404（App Router `not-found.tsx`）。
 *
 * 之前没有全局 not-found：静态导出下访问不存在的路径会落到框架默认页
 * （英文、无系统视觉），与全站"统一页头 + 明确下一步"的口径不一致。
 *
 * 口径：唯一 h1 来自 PageHeader；给"返回首页"这个确定可用的出口
 * （首页会按角色再落到客户管理/产品目录），不依赖浏览器后退。
 */
export default function NotFound() {
  return (
    <div className="page-container">
      <PageHeader
        title="页面不存在"
        description="地址可能输错，或该页面已被移动/下线。"
      />

      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border bg-card px-6 py-16 text-center">
        <p className="text-5xl font-semibold tracking-tight text-muted-foreground">
          404
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          找不到这个页面。可以返回首页，或从侧边栏选择要使用的工位。
        </p>
        <Link href="/">
          <Button>返回首页</Button>
        </Link>
      </div>
    </div>
  );
}
