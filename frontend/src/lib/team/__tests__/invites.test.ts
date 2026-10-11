import { describe, expect, it } from "vitest";

import {
  buildInviteLink,
  extractInviteToken,
  inviteStateLabel,
  isInviteActionable,
} from "../invites";

describe("buildInviteLink", () => {
  it("拼成 /register?token=…（后端会自己从链接取 token）", () => {
    expect(buildInviteLink("AbC123", "https://kaas.example.com")).toBe(
      "https://kaas.example.com/register?token=AbC123",
    );
  });

  it("origin 末尾的斜杠不会拼出双斜杠", () => {
    expect(buildInviteLink("AbC123", "https://kaas.example.com/")).toBe(
      "https://kaas.example.com/register?token=AbC123",
    );
  });

  it("token 做 URL 编码（邀请码未来可能含特殊字符）", () => {
    expect(buildInviteLink("a b&c", "https://x.test")).toBe(
      "https://x.test/register?token=a%20b%26c",
    );
  });
});

describe("extractInviteToken", () => {
  it("整条邀请链接 → 抠出 token", () => {
    expect(
      extractInviteToken("https://kaas.example.com/register?token=AbC123"),
    ).toBe("AbC123");
  });

  it("链接里还有别的参数也能取到", () => {
    expect(
      extractInviteToken(
        "https://kaas.example.com/register?from=email&token=AbC123&x=1",
      ),
    ).toBe("AbC123");
  });

  it("纯邀请码原样返回", () => {
    expect(extractInviteToken("  AbC123  ")).toBe("AbC123");
  });

  it("空串保持空（调用方据此报「请填写邀请码」）", () => {
    expect(extractInviteToken("   ")).toBe("");
  });
});

describe("邀请状态", () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();

  it("pending + 未过期 = 待接受", () => {
    expect(inviteStateLabel("pending", future)).toBe("待接受");
    expect(isInviteActionable("pending", future)).toBe(true);
  });

  it("pending 但已过 expires_at = 已过期（列表里 status 仍是 pending）", () => {
    expect(inviteStateLabel("pending", past)).toBe("已过期");
    expect(isInviteActionable("pending", past)).toBe(false);
  });

  it("已接受 / 已撤销不再可操作", () => {
    expect(inviteStateLabel("accepted", future)).toBe("已接受");
    expect(isInviteActionable("accepted", future)).toBe(false);
    expect(inviteStateLabel("revoked", future)).toBe("已撤销");
    expect(isInviteActionable("revoked", future)).toBe(false);
  });

  it("没有到期时间 = 永久有效", () => {
    expect(inviteStateLabel("pending", null)).toBe("待接受");
    expect(isInviteActionable("pending", null)).toBe(true);
  });
});
