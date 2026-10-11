"use client";

/**
 * 工位路由守卫 —— 未开通的工位**渲染引导页**，而不是让页面自己 404 报错。
 *
 * 触发有两条路（缺一不可）：
 *   ① 快照：`/me/workstations` 说这个工位没开通（用户直接输入路由也能拦住）；
 *   ② 拦截：任何页面调工位 API 被后端 404 `WORKSTATION_NOT_SUBSCRIBED` 拒了
 *      （快照可能过期，后端才是最终判定）。
 * 引导的落点是团队的工位开通区（`/team?tab=subscriptions`）——
 * 团队/订阅接口属于"永不锁死"的路径，被拦的用户始终能走得到那里。
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, RefreshCw, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTeam } from "@/lib/team/team-context";
import { workstationName } from "@/lib/workstation/visibility";

interface LockedProps {
  workstationKey: string;
  hasTeam: boolean;
  isTeamAdmin: boolean;
  onRetry: () => void;
}

function WorkstationLockedGuide({
  workstationKey,
  hasTeam,
  isTeamAdmin,
  onRetry,
}: LockedProps) {
  const name = workstationName(workstationKey);

  return (
    <div className="flex min-h-[60vh] items-center justify-center py-10">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
            {hasTeam ? (
              <Lock className="size-5 text-muted-foreground" />
            ) : (
              <Users className="size-5 text-muted-foreground" />
            )}
          </div>
          <CardTitle className="text-xl">
            {hasTeam ? "该工位未开通" : "你还没有加入团队"}
          </CardTitle>
          <CardDescription>
            {hasTeam ? (
              <>
                「{name}」还没有在你的团队开通，所以暂时用不了。
                {isTeamAdmin
                  ? "你是团队管理员，可以在「团队与工位」里直接开通。"
                  : "请联系团队管理员在「团队与工位」里开通。"}
              </>
            ) : (
              <>
                工位订阅挂在团队上 —— 没有团队就没有订阅主体，所以「{name}
                」现在还不能使用。
                先创建一个团队（你会成为团队管理员），或凭邀请码加入同事的团队。
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap justify-center gap-2">
            {hasTeam ? (
              <>
                <Link
                  href={{ pathname: "/team", query: { tab: "subscriptions" } }}
                >
                  <Button>去团队与工位开通</Button>
                </Link>
                <Button variant="outline" onClick={onRetry}>
                  <RefreshCw className="mr-1 size-4" />
                  重新检查
                </Button>
              </>
            ) : (
              <>
                <Link href={{ pathname: "/team", query: { tab: "create" } }}>
                  <Button>创建团队</Button>
                </Link>
                <Link href={{ pathname: "/team", query: { tab: "join" } }}>
                  <Button variant="outline">加入团队</Button>
                </Link>
              </>
            )}
          </div>
          <p className="text-center text-xs text-muted-foreground">
            该工位未开通时，相关接口会返回
            404；开通后点「重新检查」即可，无需重新登录。
            <span className="ml-1 font-mono opacity-70">
              ({workstationKey})
            </span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function WorkstationGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { access, refresh, isTeamAdmin, snapshot } = useTeam();
  const state = access(pathname ?? "");

  if (state.kind === "not-subscribed" || state.kind === "no-team") {
    return (
      <WorkstationLockedGuide
        workstationKey={state.workstationKey}
        hasTeam={state.kind === "not-subscribed" && snapshot.hasTeam}
        isTeamAdmin={isTeamAdmin}
        onRetry={() => {
          void refresh();
        }}
      />
    );
  }

  // ok / unknown：信息没拿到时放行（降级），不让接口缺失把用户挡在门外
  return <>{children}</>;
}
