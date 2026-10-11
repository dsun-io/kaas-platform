import { describe, expect, it, vi, beforeEach } from "vitest";
import { AxiosError } from "axios";

vi.mock("@/lib/error/sentry", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from "sonner";

import { handleApiError } from "../error-handler";
import type { ApiErrorResponse } from "../error-handler";
import {
  resetWorkstationLockListeners,
  subscribeWorkstationLock,
} from "@/lib/workstation/lock-events";

function makeAxiosError(
  status: number,
  data: Record<string, unknown>,
  config?: Record<string, unknown>,
) {
  const requestConfig = (config ??
    {}) as unknown as import("axios").InternalAxiosRequestConfig;
  const response = {
    status,
    data,
    statusText: "Not Found",
    headers: {},
    config: requestConfig,
  } as unknown as import("axios").AxiosResponse;
  return new AxiosError(
    "Request failed",
    "ERR_BAD_REQUEST",
    requestConfig,
    undefined,
    response,
  ) as unknown as AxiosError<ApiErrorResponse>;
}

describe("handleApiError · 工位未开通拦截", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    resetWorkstationLockListeners();
  });

  it("404 WORKSTATION_NOT_SUBSCRIBED：广播工位 key，且**不弹**通用错误", () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeWorkstationLock((ws) => seen.push(ws));

    const message = handleApiError(
      makeAxiosError(404, {
        error: "not_found",
        code: "WORKSTATION_NOT_SUBSCRIBED",
        workstation: "customers",
        detail: "该工位未开通，请在“工位开通”里启用",
      }),
    );

    expect(toast.error).not.toHaveBeenCalled();
    expect(seen).toEqual(["customers"]);
    expect(message).toContain("未开通");
    unsubscribe();
  });

  it("silent 请求失败：不弹 toast（由页面自己降级）", () => {
    handleApiError(
      makeAxiosError(
        404,
        { error: "not_found" },
        { url: "/teams/me", silent: true },
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("团队错误码：弹中文文案（嵌套 detail 也认）", () => {
    const message = handleApiError(
      makeAxiosError(409, {
        detail: {
          error: "conflict",
          code: "ALREADY_IN_TEAM",
          message: "你已属于一个团队",
        },
      }),
    );
    expect(message).toBe("你已属于一个团队");
    expect(toast.error).toHaveBeenCalledWith("你已属于一个团队");
  });
});
