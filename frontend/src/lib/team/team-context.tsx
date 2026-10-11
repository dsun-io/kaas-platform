"use client";

/**
 * 团队 + 工位上下文 —— 首屏一次性拿齐"我是谁 / 我在哪个团队 / 我开通了哪些工位"。
 *
 * 为什么要有这层 Provider（而不是各页面各拉一次）：
 *   ① 侧边栏、顶栏、路由守卫（WorkstationGate）都要这份信息，各自拉会不一致、
 *      还会出现"入口先出现再消失"的闪烁；
 *   ② 未开通工位的 404 是**全局**信号（任何页面任何请求都可能撞上），
 *      必须有唯一的地方接住它，才能保证"渲染引导页而不是弹通用错误"。
 *
 * 降级策略（硬性要求：接口可能还没上线，绝不能白屏/崩）：
 *   · 两个请求各自 try/catch，失败只降级不抛；
 *   · `/me/workstations` 失败 → `snapshot.ok = false` → 前端**一律放行**（宁可多给入口，
 *     也不能因为接口没上线就把用户锁在自己的系统外面）；
 *   · 团队名在 `/teams/me` 失败时用登录态里的 `team_name` 兜底，顶栏不至于空着。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import apiClient from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { subscribeWorkstationLock } from "@/lib/workstation/lock-events";
import {
  FULL_CHAIN_CODE,
  INITIAL_WORKSTATION_SNAPSHOT,
  parseMyWorkstationsPayload,
  resolveWorkstationAccess,
  type WorkstationAccessState,
  type WorkstationSnapshot,
} from "@/lib/workstation/visibility";

/** `GET /teams/me` 里的 team 对象（已归一化） */
export interface TeamInfo {
  id: number;
  name: string;
  created_by: number | string | null;
  is_admin: boolean;
  member_count: number;
}

interface TeamContextValue {
  /** 工位快照（侧边栏过滤 / 路由守卫都读它） */
  snapshot: WorkstationSnapshot;
  team: TeamInfo | null;
  /** 团队名（接口失败时用登录态兜底） */
  teamName: string | null;
  isTeamAdmin: boolean;
  memberCount: number;
  /** 重新拉取团队 + 工位（加入/创建团队、开通工位后调用） */
  refresh: () => Promise<void>;
  /** 当前路由的工位访问状态 */
  access: (pathname: string) => WorkstationAccessState;
}

const TeamContext = createContext<TeamContextValue | null>(null);

interface TeamFetchResult {
  ok: boolean;
  team: TeamInfo | null;
  isTeamAdmin: boolean;
  memberCount: number;
}

interface WorkstationsFetchResult {
  ok: boolean;
  workstations: string[];
  codes: string[];
  isPlatformAdmin: boolean;
  /** null = 后端没给这个字段（老版本），调用方自行兜底 */
  hasTeam: boolean | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** 把 `team` 字段归一化；形状不对就当成"没有团队"，绝不把坏数据塞进 UI */
function normalizeTeam(raw: unknown): TeamInfo | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const id = typeof obj["id"] === "number" ? obj["id"] : Number(obj["id"]);
  const name = typeof obj["name"] === "string" ? obj["name"].trim() : "";
  if (!Number.isFinite(id) || name === "") return null;
  const createdBy = obj["created_by"];
  return {
    id,
    name,
    created_by:
      typeof createdBy === "number" || typeof createdBy === "string"
        ? createdBy
        : null,
    is_admin: obj["is_admin"] === true,
    member_count:
      typeof obj["member_count"] === "number" ? obj["member_count"] : 0,
  };
}

async function fetchMyTeam(): Promise<TeamFetchResult> {
  try {
    const { data } = await apiClient.get<unknown>("/teams/me", {
      silent: true,
    });
    const body = asRecord(data);
    // 响应形状不认识（老后端 / 网关返回了别的东西）→ 当"没读到"，
    // 而不是当"没有团队"：后者会把人推去建一个他其实已经有的团队
    if (!body)
      return { ok: false, team: null, isTeamAdmin: false, memberCount: 0 };
    const team = normalizeTeam(body["team"]);
    return {
      ok: true,
      team,
      isTeamAdmin: body["is_admin"] === true || team?.is_admin === true,
      memberCount:
        typeof body["member_count"] === "number"
          ? body["member_count"]
          : (team?.member_count ?? 0),
    };
  } catch {
    // 接口未上线 / 网络不通：降级为"不知道"，由调用方决定怎么显示
    return { ok: false, team: null, isTeamAdmin: false, memberCount: 0 };
  }
}

async function fetchMyWorkstations(): Promise<WorkstationsFetchResult> {
  try {
    const { data } = await apiClient.get<unknown>("/me/workstations", {
      silent: true,
    });
    // 契约要求 `workstations` 是数组。形状不认识（老后端 / 中间层）时按"没读到"处理
    // → 前端放行；若当成"一个都没开通"，会把所有工位入口和页面全给锁掉。
    const parsed = parseMyWorkstationsPayload(data);
    if (!parsed) {
      return {
        ok: false,
        workstations: [],
        codes: [],
        isPlatformAdmin: false,
        hasTeam: null,
      };
    }
    return { ok: true, ...parsed };
  } catch {
    return {
      ok: false,
      workstations: [],
      codes: [],
      isPlatformAdmin: false,
      hasTeam: null,
    };
  }
}

export function TeamProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [snapshot, setSnapshot] = useState<WorkstationSnapshot>(
    INITIAL_WORKSTATION_SNAPSHOT,
  );
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [isTeamAdmin, setIsTeamAdmin] = useState(false);
  const [memberCount, setMemberCount] = useState(0);

  // 只有"首屏第一次"才显示骨架；之后的刷新不该让侧边栏再闪一次
  const initialized = useRef(false);
  // 404 拦截触发的刷新做节流：避免"刷新→页面重试→再 404"把接口打成风暴
  const lastLockRefreshAt = useRef(0);

  // 登录态里的团队信息只做**兜底**（接口没上线时顶栏也得有名字）
  const authTeamId = user?.team_id ?? null;
  const authTeamName = user?.team_name ?? null;

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      // 未登录：AuthGate 会把人送去登录页，这里只负责"别卡在骨架上"。
      // 刻意**不**把 initialized 置为 true —— 登录态就绪后的第一次拉取必须还能出骨架，
      // 否则会先渲染全量入口、再被过滤掉（正是要避免的"闪现后消失"）。
      setSnapshot({ ...INITIAL_WORKSTATION_SNAPSHOT, loading: authLoading });
      setTeam(null);
      setIsTeamAdmin(false);
      setMemberCount(0);
      return;
    }

    // 只有"首屏第一次"才显示骨架；之后的刷新不该让侧边栏再闪一次
    if (!initialized.current) {
      setSnapshot((prev) => ({ ...prev, loading: true }));
    }

    const [teamRes, wsRes] = await Promise.all([
      fetchMyTeam(),
      fetchMyWorkstations(),
    ]);
    initialized.current = true;

    setTeam(teamRes.team);
    setIsTeamAdmin(teamRes.isTeamAdmin);
    setMemberCount(teamRes.memberCount);

    setSnapshot((prev) => {
      // 之前被 404 拒过的工位：只有新数据明确说"现在开通了"才解除拦截，
      // 否则（尤其接口又没读到）保持拦截 —— 明确的 404 比"没数据"更可信。
      const locked = prev.lockedWorkstation;
      const lockedNowEnabled =
        locked !== null &&
        wsRes.ok &&
        (wsRes.isPlatformAdmin ||
          wsRes.codes.includes(FULL_CHAIN_CODE) ||
          wsRes.workstations.includes(locked));

      return {
        loading: false,
        ok: wsRes.ok,
        workstations: wsRes.workstations,
        codes: wsRes.codes,
        isPlatformAdmin: wsRes.isPlatformAdmin,
        // has_team 的兜底顺序：/me/workstations → /teams/me → 登录态 team_id
        hasTeam:
          wsRes.hasTeam ??
          (teamRes.ok ? teamRes.team !== null : authTeamId !== null),
        lockedWorkstation: lockedNowEnabled ? null : locked,
      };
    });
  }, [isAuthenticated, authLoading, authTeamId]);

  // 登录态变化（含首次登录）时对齐一次
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 订阅"工位被拒"事件：记下被拒工位 + 对齐一次快照
  useEffect(
    () =>
      subscribeWorkstationLock((workstation) => {
        setSnapshot((prev) => ({ ...prev, lockedWorkstation: workstation }));
        if (workstation === null) return;
        const now = Date.now();
        if (now - lastLockRefreshAt.current < 3000) return;
        lastLockRefreshAt.current = now;
        void refresh();
      }),
    [refresh],
  );

  const access = useCallback(
    (pathname: string) => resolveWorkstationAccess({ pathname, snapshot }),
    [snapshot],
  );

  const value = useMemo<TeamContextValue>(
    () => ({
      snapshot,
      team,
      teamName: team?.name ?? authTeamName,
      isTeamAdmin,
      memberCount,
      refresh,
      access,
    }),
    [snapshot, team, authTeamName, isTeamAdmin, memberCount, refresh, access],
  );

  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>;
}

export function useTeam(): TeamContextValue {
  const ctx = useContext(TeamContext);
  if (!ctx) {
    throw new Error("useTeam must be used within TeamProvider");
  }
  return ctx;
}
