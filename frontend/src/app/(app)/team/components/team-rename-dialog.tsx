"use client";

/**
 * 团队改名弹窗（C36 #12）。
 *
 * 契约：`PATCH /api/v1/teams/{id}` body `{name}`（`backend/worker/src/ws_teams.py:245`）：
 * - 仅团队管理员（403 `NOT_TEAM_ADMIN` / 非管理员）；
 * - 名称规则由内核 `validate_team_name` 校验（422，通常是 2–30 字符）；
 * - 同名团队 ⇒ 409 `TEAM_NAME_TAKEN`。
 *
 * 错误用 `teamErrorMessage`（码表 + 后端中文文案）原样展示，不吞成"操作失败"。
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import apiClient from "@/lib/api/client";
import { teamErrorMessage } from "@/lib/team/team-errors";
import { toast } from "sonner";

export function TeamRenameDialog({
  open,
  onOpenChange,
  teamId,
  currentName,
  onRenamed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: number;
  currentName: string;
  /** 改名成功后调用方负责刷新团队上下文（`useTeam().refresh`） */
  onRenamed?: (name: string) => void;
}) {
  // 调用方在关闭时会**卸载**本弹窗（team/page.tsx 里条件渲染），
  // 因此这里直接用 props 初始化即可，不需要 useEffect 同步（那会触发级联渲染告警）。
  const [name, setName] = useState(currentName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== currentName && !pending;

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const { data } = await apiClient.patch<{ name?: string }>(
        `/teams/${teamId}`,
        { name: trimmed },
        { silent: true },
      );
      toast.success("团队名称已更新");
      onOpenChange(false);
      onRenamed?.(data?.name ?? trimmed);
    } catch (err) {
      setError(teamErrorMessage(err, "改名失败，请稍后重试"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>团队改名</DialogTitle>
          <DialogDescription>
            团队名称会显示在单据/报表与成员页；仅团队管理员可修改。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="team-rename-input">团队名称</Label>
          <Input
            id="team-rename-input"
            value={name}
            disabled={pending}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="2–30 个字符"
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {pending ? "保存中…" : "保存名称"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
