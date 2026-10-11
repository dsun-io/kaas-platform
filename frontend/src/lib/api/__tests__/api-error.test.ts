import { describe, expect, it } from "vitest";

import { normalizeApiError, normalizeApiErrorPayload } from "../api-error";

/** 构造一个"axios 形状"的错误（只用到 response.data / response.status / message） */
function axiosLike(
  status: number | null,
  data: unknown,
  message = "Request failed",
) {
  return {
    message,
    response: status === null ? undefined : { status, data },
  };
}

describe("normalizeApiErrorPayload（两种错误外形都认）", () => {
  it("扁平体：工位中间件直接吐 JSONResponse", () => {
    const parsed = normalizeApiErrorPayload(
      {
        error: "not_found",
        code: "WORKSTATION_NOT_SUBSCRIBED",
        workstation: "customers",
        detail: "该工位未开通，请在“工位开通”里启用",
      },
      404,
    );
    expect(parsed.code).toBe("WORKSTATION_NOT_SUBSCRIBED");
    expect(parsed.workstation).toBe("customers");
    expect(parsed.message).toContain("未开通");
  });

  it("嵌套体：HTTPException(detail={...}) 被框架包了一层", () => {
    const parsed = normalizeApiErrorPayload(
      {
        detail: {
          error: "conflict",
          code: "ALREADY_IN_TEAM",
          message: "你已属于一个团队，不能再创建团队",
        },
      },
      409,
    );
    expect(parsed.code).toBe("ALREADY_IN_TEAM");
    expect(parsed.message).toBe("你已属于一个团队，不能再创建团队");
  });

  it("嵌套体 + detail 字符串（内核 422 规则违例）", () => {
    const parsed = normalizeApiErrorPayload(
      {
        detail: {
          error: "validation",
          code: "INVALID_TEAM_NAME",
          detail: "团队名称需 2-30 个字符",
        },
      },
      422,
    );
    expect(parsed.code).toBe("INVALID_TEAM_NAME");
    expect(parsed.message).toBe("团队名称需 2-30 个字符");
    expect(parsed.detail).toBe("团队名称需 2-30 个字符");
  });

  it("纯字符串 detail（注册接口的旧写法）", () => {
    const parsed = normalizeApiErrorPayload(
      { detail: "conflict: Email already registered" },
      409,
    );
    expect(parsed.message).toBe("conflict: Email already registered");
    expect(parsed.code).toBeNull();
  });

  it("空体不炸", () => {
    const parsed = normalizeApiErrorPayload(undefined, 500);
    expect(parsed.code).toBeNull();
    expect(parsed.message).toBe("");
  });
});

describe("normalizeApiError（异常外壳）", () => {
  it("网络错误：无 response，保留 error.message", () => {
    const parsed = normalizeApiError({ message: "Network Error" });
    expect(parsed.isNetworkError).toBe(true);
    expect(parsed.status).toBeNull();
    expect(parsed.message).toBe("Network Error");
  });

  it("后端给了 message 就用后端的（不吞掉）", () => {
    const parsed = normalizeApiError(
      axiosLike(
        404,
        { code: "MEMBER_NOT_FOUND" },
        "Request failed with status code 404",
      ),
    );
    expect(parsed.code).toBe("MEMBER_NOT_FOUND");
    expect(parsed.message).toBe("Request failed with status code 404");
    expect(parsed.isNetworkError).toBe(false);
  });
});
