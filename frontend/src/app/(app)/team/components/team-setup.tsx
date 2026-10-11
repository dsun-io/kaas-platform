"use client";

/**
 * 「创建团队 / 加入团队」引导（`GET /teams/me` 返回 `team=null` 时显示）。
 *
 * 业务约束（docs/TEAMS_AND_VISIBILITY.md §1）：
 *   · 一个用户同一时刻只属于一个团队 → 已有团队时由页面拦住，不给进到这里；
 *   · 加入现有团队**必须凭邀请码**（否则任何公司都能自由进别人的团队看数据）；
 *   · 建团队时顺手开通工位 —— 不开通的团队"进得去但什么都用不了"，用户自己修不好。
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, LogIn, Plus } from "lucide-react";

import apiClient from "@/lib/api/client";
import { buildInviteLink } from "@/lib/team/invites";
import { teamErrorMessage } from "@/lib/team/team-errors";
import { subscribableWorkstationOptions } from "@/lib/workstation/visibility";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WorkstationPicker } from "@/components/workstation-picker";

const ALL_STATION_KEYS = subscribableWorkstationOptions().map((s) => s.key);

interface TeamSetupProps {
  /** 来自 `/team?tab=create|join`（工位引导页会带过来） */
  initialMode?: "create" | "join";
  onDone: () => void | Promise<void>;
}

export function TeamSetup({ initialMode = "create", onDone }: TeamSetupProps) {
  const [mode, setMode] = useState<"create" | "join">(initialMode);
  const [name, setName] = useState("");
  const [stations, setStations] = useState<string[]>(ALL_STATION_KEYS);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function createTeam() {
    if (!name.trim()) {
      setError("请填写团队名称");
      return;
    }
    if (stations.length === 0) {
      // 空数组 ≠ 不传：后端会把"一个都不开"如实落库，团队就废了
      setError("请至少勾选一个要开通的工位（当前全部免费）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiClient.post(
        "/teams",
        { name: name.trim(), workstations: stations },
        { silent: true },
      );
      toast.success("团队已创建，你是团队管理员");
      await onDone();
    } catch (err: unknown) {
      setError(teamErrorMessage(err, "创建团队失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  async function joinTeam() {
    if (token.trim() === "") {
      setError("请填写邀请码或整条邀请链接");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // 整条邀请链接也可以：后端 normalize_invite_token 会自己取 ?token=
      await apiClient.post(
        "/teams/join",
        { token: token.trim() },
        { silent: true },
      );
      toast.success("已加入团队");
      await onDone();
    } catch (err: unknown) {
      setError(teamErrorMessage(err, "加入团队失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="size-4" />
            创建团队
          </CardTitle>
          <CardDescription>
            你会成为团队管理员：可以邀请同事、开通工位。成员录入的客户/报价/单证在本团队内互相可见。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="team-create-name">团队名称 *</Label>
            <Input
              id="team-create-name"
              placeholder="如：安平县联佳丝网制品有限公司"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>
          <WorkstationPicker
            value={stations}
            onChange={setStations}
            disabled={busy}
            idPrefix="team-create"
          />
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => {
              setMode("create");
              void createTeam();
            }}
          >
            {busy && mode === "create" && (
              <Loader2 className="mr-2 size-4 animate-spin" />
            )}
            创建团队
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LogIn className="size-4" />
            加入现有团队
          </CardTitle>
          <CardDescription>
            必须凭邀请码 —— 这样别的公司就不能随便进来看到你的数据。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="team-join-token">邀请码 / 邀请链接 *</Label>
            <Input
              id="team-join-token"
              placeholder="粘贴同事发来的邀请链接或邀请码"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              整条邀请链接直接粘贴即可，系统会自动识别其中的邀请码。
            </p>
          </div>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => {
              setMode("join");
              void joinTeam();
            }}
          >
            {busy && mode === "join" && (
              <Loader2 className="mr-2 size-4 animate-spin" />
            )}
            加入团队
          </Button>
        </CardContent>
      </Card>

      {error && (
        <p className="text-sm text-destructive lg:col-span-2">{error}</p>
      )}
      <p className="text-xs text-muted-foreground lg:col-span-2">
        邀请链接形如：
        <span className="ml-1 font-mono">{buildInviteLink("邀请码示例")}</span>
      </p>
    </div>
  );
}
