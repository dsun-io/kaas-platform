import { describe, expect, it } from "vitest";
import { visibleNavGroups, workstationByRoute } from "@contracts/workstations";

import {
  filterNavGroups,
  INITIAL_WORKSTATION_SNAPSHOT,
  isSubscribableWorkstation,
  isWorkstationEnabled,
  parseMyWorkstationsPayload,
  resolveWorkstationAccess,
  subscribableWorkstationOptions,
  SUBSCRIBABLE_WORKSTATIONS,
  workstationName,
  type WorkstationSnapshot,
} from "../visibility";

function snapshot(partial: Partial<WorkstationSnapshot>): WorkstationSnapshot {
  return {
    ...INITIAL_WORKSTATION_SNAPSHOT,
    loading: false,
    ok: true,
    ...partial,
  };
}

describe("工位清单（契约派生）", () => {
  it("可订阅工位与后端 WORKSTATION_PATHS 对齐（9 个）", () => {
    expect([...SUBSCRIBABLE_WORKSTATIONS].sort()).toEqual(
      [
        "customers",
        "intel",
        "leadgen",
        "orders",
        "outreach",
        "quotes",
        "research",
        "shipments",
        "trade-docs",
      ].sort(),
    );
  });

  it("选项来自契约：名称与侧边栏同一份，顺序与可见工位一致", () => {
    const options = subscribableWorkstationOptions();
    const names = options.map((o) => o.name);
    expect(names).toContain("报价");
    expect(names).toContain("客户管理");
    expect(names).toContain("单证");
    // 顺序 = 契约里 visibleWorkstations 的顺序（过滤掉非计费工位后）
    const expected = visibleNavGroups()
      .flatMap((g) => g.items)
      .map((w) => w.key)
      .filter((key) => isSubscribableWorkstation(key));
    expect(options.map((o) => o.key)).toEqual(expected);
  });

  it("非计费工位（仪表盘/设置）不算订阅工位", () => {
    expect(isSubscribableWorkstation("dashboard")).toBe(false);
    expect(isSubscribableWorkstation("settings")).toBe(false);
    expect(isSubscribableWorkstation("quotes")).toBe(true);
  });

  it("workstationName 与契约一致，未知 key 原样返回", () => {
    expect(workstationName("quotes")).toBe("报价");
    expect(workstationName("nope")).toBe("nope");
  });
});

describe("isWorkstationEnabled（能力边界）", () => {
  it("平台管理员不受限：一个都没开通也能用", () => {
    expect(
      isWorkstationEnabled(
        snapshot({ isPlatformAdmin: true, workstations: [] }),
        "quotes",
      ),
    ).toBe(true);
  });

  it("full_chain = 全工位套餐", () => {
    expect(
      isWorkstationEnabled(snapshot({ codes: ["full_chain"] }), "trade-docs"),
    ).toBe(true);
  });

  it("没读到工位信息（接口未上线）→ 一律放行，不凭空锁死用户", () => {
    expect(
      isWorkstationEnabled(snapshot({ ok: false, workstations: [] }), "quotes"),
    ).toBe(true);
  });

  it("非计费工位永远可用", () => {
    expect(
      isWorkstationEnabled(snapshot({ workstations: [] }), "settings"),
    ).toBe(true);
  });

  it("普通成员按已开通清单判定", () => {
    const snap = snapshot({ workstations: ["customers"] });
    expect(isWorkstationEnabled(snap, "customers")).toBe(true);
    expect(isWorkstationEnabled(snap, "quotes")).toBe(false);
  });
});

describe("filterNavGroups（侧边栏过滤）", () => {
  it("只开通 customers：报价/订单/单证入口消失，仪表盘与设置保留", () => {
    const groups = filterNavGroups(
      visibleNavGroups(),
      snapshot({ workstations: ["customers"] }),
    );
    const keys = groups.flatMap((g) => g.items.map((w) => w.key));
    expect(keys).toContain("dashboard");
    expect(keys).toContain("customers");
    expect(keys).toContain("settings");
    expect(keys).not.toContain("quotes");
    expect(keys).not.toContain("orders");
    expect(keys).not.toContain("trade-docs");
  });

  it("被过滤空的分组不再渲染（不留下光秃秃的组标题）", () => {
    const groups = filterNavGroups(
      visibleNavGroups(),
      snapshot({ workstations: [] }),
    );
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });
});

describe("parseMyWorkstationsPayload（契约形状守卫）", () => {
  it("正常响应：拿到工位、编码、管理员与 has_team", () => {
    const parsed = parseMyWorkstationsPayload({
      workstations: ["customers", "quotes"],
      codes: ["customers", "quotes"],
      is_admin: false,
      has_team: true,
    });
    expect(parsed).toEqual({
      workstations: ["customers", "quotes"],
      codes: ["customers", "quotes"],
      isPlatformAdmin: false,
      hasTeam: true,
    });
  });

  it("workstations 字段缺失 → null（当没读到，绝不锁死用户）", () => {
    expect(parseMyWorkstationsPayload({ codes: ["full_chain"] })).toBeNull();
    expect(parseMyWorkstationsPayload(null)).toBeNull();
    expect(parseMyWorkstationsPayload("oops")).toBeNull();
  });

  it("has_team 缺失 → null（由调用方用登录态兜底）", () => {
    const parsed = parseMyWorkstationsPayload({ workstations: [] });
    expect(parsed?.hasTeam).toBeNull();
    expect(parsed?.workstations).toEqual([]);
  });

  it("数组里的非字符串被丢掉，不污染判定", () => {
    const parsed = parseMyWorkstationsPayload({
      workstations: ["quotes", 42, "", "  "],
      codes: null,
    });
    expect(parsed?.workstations).toEqual(["quotes"]);
    expect(parsed?.codes).toEqual([]);
  });
});

describe("resolveWorkstationAccess（未开通引导）", () => {
  it("直接输入未开通工位路由 → not-subscribed（渲染引导页而不是报错）", () => {
    const state = resolveWorkstationAccess({
      pathname: "/quotes",
      snapshot: snapshot({ hasTeam: true, workstations: ["customers"] }),
    });
    expect(state).toEqual({ kind: "not-subscribed", workstationKey: "quotes" });
  });

  it("已开通工位正常放行", () => {
    expect(
      resolveWorkstationAccess({
        pathname: "/customers/123",
        snapshot: snapshot({ hasTeam: true, workstations: ["customers"] }),
      }),
    ).toEqual({ kind: "ok" });
  });

  it("没有团队 → no-team（先创建/加入团队，而不是「去开通工位」）", () => {
    expect(
      resolveWorkstationAccess({
        pathname: "/quotes",
        snapshot: snapshot({ hasTeam: false, workstations: [] }),
      }),
    ).toEqual({ kind: "no-team", workstationKey: "quotes" });
  });

  it("非工位路由（/team）永远放行 —— 否则用户没法去开通", () => {
    expect(
      resolveWorkstationAccess({
        pathname: "/team",
        snapshot: snapshot({ hasTeam: false, workstations: [] }),
      }),
    ).toEqual({ kind: "ok" });
  });

  it("非计费工位（/dashboard）不受订阅限制", () => {
    expect(
      resolveWorkstationAccess({
        pathname: "/dashboard",
        snapshot: snapshot({ hasTeam: true, workstations: [] }),
      }),
    ).toEqual({ kind: "ok" });
  });

  it("工位信息没读到 → unknown（放行）", () => {
    expect(
      resolveWorkstationAccess({
        pathname: "/quotes",
        snapshot: snapshot({ ok: false, hasTeam: true }),
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("后端 404 明确拒绝时以它为准（快照过期也要拦）", () => {
    expect(
      resolveWorkstationAccess({
        pathname: "/quotes",
        snapshot: snapshot({
          hasTeam: true,
          workstations: ["quotes"],
          codes: ["quotes"],
          lockedWorkstation: "quotes",
        }),
      }),
    ).toEqual({ kind: "not-subscribed", workstationKey: "quotes" });
  });

  it("拦截记录只对当前路由的工位生效，换页不黏住", () => {
    expect(
      resolveWorkstationAccess({
        pathname: "/quotes",
        snapshot: snapshot({
          hasTeam: true,
          workstations: ["quotes"],
          lockedWorkstation: "customers",
        }),
      }),
    ).toEqual({ kind: "ok" });
  });

  it("平台管理员不受限", () => {
    expect(
      resolveWorkstationAccess({
        pathname: "/quotes",
        snapshot: snapshot({
          hasTeam: true,
          isPlatformAdmin: true,
          workstations: [],
        }),
      }),
    ).toEqual({ kind: "ok" });
  });

  it("契约里能按路由找到工位（守卫依赖它）", () => {
    expect(workstationByRoute("/quotes")?.key).toBe("quotes");
    // `/team` 已在契约里（`status: 'hidden'`）：
    //   1) 能按路由解析 → 面包屑/标题拿得到名字（之前它是页面在、契约不在）
    //   2) 不上侧边栏 → 入口在右上角头像菜单
    //   3) `subscription: null` → **永不被订阅拦**：它是"某工位未开通"时的自救入口，
    //      如果它自己被锁，用户就没有任何办法去开通工位了
    const team = workstationByRoute("/team");
    expect(team?.key).toBe("team");
    expect(team?.status).toBe("hidden");
    expect(team?.subscription).toBeNull();
  });
});
