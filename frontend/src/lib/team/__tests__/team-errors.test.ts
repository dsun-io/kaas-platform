import { describe, expect, it } from "vitest";

import { teamErrorMessage, TEAM_ERROR_TEXT } from "../team-errors";

function apiError(status: number, data: unknown, message = "Request failed") {
  return { message, response: { status, data } };
}

describe("teamErrorMessage", () => {
  it("后端给了中文 message 就以它为准（不吞掉具体情况）", () => {
    expect(
      teamErrorMessage(
        apiError(409, {
          detail: {
            error: "conflict",
            code: "TEAM_NAME_TAKEN",
            message: "已存在同名团队「联佳丝网」",
          },
        }),
      ),
    ).toBe("已存在同名团队「联佳丝网」");
  });

  it("后端文案是英文技术信息时用码表中文", () => {
    expect(
      teamErrorMessage(
        apiError(409, {
          detail: {
            error: "conflict",
            code: "ALREADY_IN_TEAM",
            message: "User already belongs to a team",
          },
        }),
      ),
    ).toBe(TEAM_ERROR_TEXT["ALREADY_IN_TEAM"]);
  });

  it("只有 code（410 INVITE_EXPIRED 不带 message）也能给人话", () => {
    expect(
      teamErrorMessage(
        apiError(410, { detail: { error: "gone", code: "INVITE_EXPIRED" } }),
      ),
    ).toBe("邀请已过期");
  });

  it("只有 code（404 MEMBER_NOT_FOUND）", () => {
    expect(
      teamErrorMessage(
        apiError(404, {
          detail: { error: "not_found", code: "MEMBER_NOT_FOUND" },
        }),
      ),
    ).toBe("该成员不在本团队");
  });

  it("未知 code + 英文原文：原样透出，不假装成功", () => {
    expect(
      teamErrorMessage(
        apiError(400, {
          detail: { code: "SOMETHING_NEW", message: "boom detail" },
        }),
      ),
    ).toBe("boom detail");
  });

  it("网络错误 / 什么都没有 → 兜底文案", () => {
    expect(teamErrorMessage({ message: "Network Error" }, "兜底")).toBe("兜底");
  });

  it("码表覆盖文档 §B2 要求的全部错误码", () => {
    const required = [
      "ALREADY_IN_TEAM",
      "TEAM_NAME_TAKEN",
      "NOT_TEAM_ADMIN",
      "CANNOT_REMOVE_SELF",
      "INVITE_NOT_FOUND",
      "INVITE_REVOKED",
      "INVITE_EXPIRED",
      "INVITE_ALREADY_USED",
      "MEMBER_NOT_FOUND",
      "WORKSTATION_NOT_SUBSCRIBED",
    ];
    for (const code of required) {
      expect(TEAM_ERROR_TEXT[code], `缺少 ${code} 的中文文案`).toBeTruthy();
    }
  });
});
