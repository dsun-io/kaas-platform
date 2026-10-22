"use client";

/**
 * 创建 API 令牌对话框（W5 M1）。
 *
 * 安全铁律（设计 §2）：明文只返回一次。创建成功后**不自动关闭**：
 * - 面板切到「仅显示一次」提示，列出明文 + 复制按钮；
 * - 点击遮罩 / 按 Esc 不关闭（`disablePointerDismissal` + onOpenChange 拦截）；
 * - 只能点「我已保存，关闭」手动关闭，关闭后 state 立即清空明文。
 */
import { useState } from "react";
import { Check, Copy, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

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
import {
  API_TOKEN_SCOPES,
  API_TOKEN_SCOPE_GROUPS,
  scopeLabel,
} from "@/lib/api-tokens/scopes";
import { formatApiTokenError } from "@/lib/api-tokens/token-errors";
import {
  useCreateApiToken,
  type CreatedApiToken,
} from "@/lib/api-tokens/use-api-tokens";

/** 可选有效期：后端接受 1..3650 天，UI 只给常用档位 + 永不过期。 */
const EXPIRY_OPTIONS = [
  { value: "", label: "永不过期" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "365 天" },
] as const;

export function CreateTokenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateApiToken();

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);

  function close() {
    onOpenChange(false);
  }

  function handleOpenChange(next: boolean) {
    // 明文还在屏幕上：必须点「我已保存，关闭」才能销毁。
    // 其余关闭路径（遮罩 / Esc / 右上角 X）在 created 阶段一律忽略。
    if (!next && created) return;
    onOpenChange(next);
  }

  function toggleScope(scope: string) {
    setFormError(null);
    setSelected((prev) =>
      prev.includes(scope)
        ? prev.filter((item) => item !== scope)
        : [...prev, scope],
    );
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("请填写密钥名称（用于在列表里识别用途）。");
      return;
    }
    if (trimmed.length > 100) {
      setFormError("密钥名称最多 100 个字符。");
      return;
    }
    if (selected.length === 0) {
      setFormError("至少选择一个权限范围；没有权限的密钥无法调用任何功能。");
      return;
    }

    setFormError(null);
    try {
      const result = await create.mutateAsync({
        name: trimmed,
        scopes: selected,
        ...(expiresInDays ? { expires_in_days: Number(expiresInDays) } : {}),
      });
      if (!result.plaintext) {
        setFormError("创建成功但未拿到完整密钥，请刷新列表后重新创建。");
        return;
      }
      setCreated(result);
      setCopied(false);
      toast.success("系统对接密钥已创建");
    } catch (error) {
      setFormError(formatApiTokenError(error));
    }
  }

  async function copyPlaintext() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.plaintext);
      setCopied(true);
      toast.success("密钥已复制");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("复制失败，请手动选择完整密钥");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} disablePointerDismissal>
      <DialogContent
        showCloseButton={!created}
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl"
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>系统对接密钥已创建</DialogTitle>
              <DialogDescription>
                密钥「{created.name}」已生成。请现在保存完整密钥。
              </DialogDescription>
            </DialogHeader>

            <div
              role="status"
              aria-live="polite"
              className="space-y-3 rounded-lg border border-warning/40 bg-warning-muted p-4 text-warning-muted-foreground"
            >
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-5 shrink-0" />
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold">仅显示一次</p>
                  <p className="text-xs">
                    关闭本窗口后无法再次查看完整密钥。请立即复制并妥善保存；
                    如果泄露，请吊销后重新创建。
                  </p>
                </div>
              </div>

              <code className="block break-all rounded-md border border-warning/30 bg-background/80 p-3 font-mono text-xs text-foreground">
                {created.plaintext}
              </code>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" onClick={copyPlaintext}>
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copied ? "已复制" : "复制密钥"}
                </Button>
                <span className="text-xs">
                  {created.scopes.length} 个权限范围 ·{" "}
                  {created.expires_at ? "已设置有效期" : "永不过期"}
                </span>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" onClick={close}>
                我已保存，关闭
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>创建系统对接密钥</DialogTitle>
              <DialogDescription>
                密钥用于外部系统或自动化工具对接平台；
                完整密钥只在创建成功后显示一次。
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="api-token-name">
                  名称 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="api-token-name"
                  name="api-token-name"
                  value={name}
                  maxLength={100}
                  autoComplete="off"
                  placeholder="例如：官网询盘同步"
                  onChange={(event) => {
                    setName(event.target.value);
                    setFormError(null);
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="api-token-expiry">有效期</Label>
                <select
                  id="api-token-expiry"
                  name="expires_in_days"
                  value={expiresInDays}
                  onChange={(event) => {
                    setExpiresInDays(event.target.value);
                    setFormError(null);
                  }}
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                >
                  {EXPIRY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  到期后密钥自动失效；需要长期使用时再创建新密钥。
                </p>
              </div>

              <fieldset className="space-y-2">
                <legend className="sr-only">权限范围（至少选择一项）</legend>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    权限范围 <span className="text-destructive">*</span>
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      已选 {selected.length} / {API_TOKEN_SCOPES.length} 项
                    </span>
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="xs"
                      variant="link"
                      onClick={() => {
                        setFormError(null);
                        setSelected([...API_TOKEN_SCOPES]);
                      }}
                    >
                      全选
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="link"
                      onClick={() => {
                        setFormError(null);
                        setSelected([]);
                      }}
                    >
                      清空
                    </Button>
                  </div>
                </div>

                <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border p-3">
                  {API_TOKEN_SCOPE_GROUPS.map((group) => (
                    <div key={group.label} className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        {group.label}
                      </p>
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {group.scopes.map((scope) => (
                          <label
                            key={scope.value}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/60"
                          >
                            <input
                              type="checkbox"
                              value={scope.value}
                              checked={selected.includes(scope.value)}
                              onChange={() => toggleScope(scope.value)}
                              className="size-4 accent-primary"
                            />
                            <span className="min-w-0 flex-1">
                              {scope.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  只授予实际需要的权限；写操作会真实改业务数据。
                  {selected.length > 0
                    ? ` 当前：${selected.map(scopeLabel).join("、")}`
                    : ""}
                </p>
              </fieldset>

              {formError ? (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                >
                  {formError}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={close}
                disabled={create.isPending}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={submit}
                disabled={create.isPending}
              >
                {create.isPending ? "创建中…" : "生成密钥"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
