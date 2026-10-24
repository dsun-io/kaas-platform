/**
 * P0 灰度开关单测（src/boot-flag.ts）。
 *
 * 口径 = docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §8：默认 off（行为与今天一致）；
 * on 才走直连；白名单空 = 全部受开关控制；条目按路由 id 的 `.` 前缀段匹配。
 */
import { describe, expect, it } from "vitest";

import {
  AUTH_DB_SPLIT_OFF,
  AUTH_DB_SPLIT_ON,
  AUTH_DB_SPLIT_ROUTES_VAR,
  AUTH_DB_SPLIT_VAR,
  authDbSplitEnabled,
  authDbSplitRoutes,
  DIRECT_ROUTE_IDS,
  useDirectRoute,
} from "../src/boot-flag";
import { makeTestEnv } from "./helpers";

const ALL_IDS = Object.values(DIRECT_ROUTE_IDS);

describe("AUTH_DB_SPLIT：默认 off = 一键回退路径", () => {
  it("变量缺失 ⇒ 开关关闭、全部路由走原透传（与事故前行为逐字一致）", () => {
    const env = makeTestEnv();

    expect(authDbSplitEnabled(env)).toBe(false);
    for (const id of ALL_IDS) expect(useDirectRoute(env, id)).toBe(false);
  });

  it("只有 'on' 算开；off / 空串 / 其它值 / 非字符串一律关闭（安全默认）", () => {
    expect(authDbSplitEnabled(makeTestEnv({ [AUTH_DB_SPLIT_VAR]: AUTH_DB_SPLIT_ON }))).toBe(true);
    expect(authDbSplitEnabled(makeTestEnv({ [AUTH_DB_SPLIT_VAR]: " ON " }))).toBe(true);

    for (const value of [AUTH_DB_SPLIT_OFF, "", "   ", "true", "1", "yes", "offf"]) {
      const env = makeTestEnv({ [AUTH_DB_SPLIT_VAR]: value });
      expect(authDbSplitEnabled(env), "value=" + JSON.stringify(value)).toBe(false);
      expect(useDirectRoute(env, DIRECT_ROUTE_IDS.productsList)).toBe(false);
    }
    expect(authDbSplitEnabled(makeTestEnv({ [AUTH_DB_SPLIT_VAR]: 123 as never }))).toBe(false);
  });
});

describe("AUTH_DB_SPLIT_ROUTES：按路由 id 前缀段放量", () => {
  it("on + 白名单缺失/空 ⇒ 全部直连", () => {
    for (const raw of [undefined, "", "  ", ",,", " , "]) {
      const env = makeTestEnv({ [AUTH_DB_SPLIT_VAR]: "on", [AUTH_DB_SPLIT_ROUTES_VAR]: raw });
      expect(authDbSplitRoutes(env)).toEqual([]);
      for (const id of ALL_IDS) expect(useDirectRoute(env, id), "raw=" + String(raw)).toBe(true);
    }
  });

  it("白名单条目写域 ⇒ 覆盖该域全部端点（products 覆盖 list/profile/media，不影响通知/审批）", () => {
    const env = makeTestEnv({
      [AUTH_DB_SPLIT_VAR]: "on",
      [AUTH_DB_SPLIT_ROUTES_VAR]: "products",
    });

    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.productsList)).toBe(true);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.productsProfile)).toBe(true);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.productsMedia)).toBe(true);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.notificationsUnreadCount)).toBe(false);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.approvalsList)).toBe(false);
  });

  it("白名单条目写完整 id ⇒ 只放行那一条（便于逐个端点放量）", () => {
    const env = makeTestEnv({
      [AUTH_DB_SPLIT_VAR]: "on",
      [AUTH_DB_SPLIT_ROUTES_VAR]: " PRODUCTS.LIST , notifications.unread-count ",
    });

    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.productsList)).toBe(true);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.notificationsUnreadCount)).toBe(true);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.productsProfile)).toBe(false);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.productsMedia)).toBe(false);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.approvalsList)).toBe(false);
  });

  it("前缀按 '.' 分段：'product' 不会误命中 'products.list'（避免手滑放大放量面）", () => {
    const env = makeTestEnv({
      [AUTH_DB_SPLIT_VAR]: "on",
      [AUTH_DB_SPLIT_ROUTES_VAR]: "product,approvalsx",
    });

    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.productsList)).toBe(false);
    expect(useDirectRoute(env, DIRECT_ROUTE_IDS.approvalsList)).toBe(false);
    expect(useDirectRoute(env, "productsx.list")).toBe(false);
  });

  it("开关 off 时白名单不影响判定（关就是全关，回退不靠白名单）", () => {
    const env = makeTestEnv({
      [AUTH_DB_SPLIT_VAR]: "off",
      [AUTH_DB_SPLIT_ROUTES_VAR]: "products,notifications,approvals",
    });
    for (const id of ALL_IDS) expect(useDirectRoute(env, id)).toBe(false);
  });
});
