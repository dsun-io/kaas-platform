/** Auth types — aligned with backend POST /api/v1/auth/login, /register, GET /api/v1/auth/me */

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  display_name: string;
  /** 2026-10-19 起可选：注册页只留团队名称（公司名=团队名），后端不再强制 */
  company_name?: string;
  product_category: string;
  contact?: string;
  /**
   * 团队动作（可选，**三方互斥**，后端 422 TEAM_ACTION_CONFLICT）：
   *   · 新建团队 → `team_name`（注册者即团队管理员）+ `workstations`（要开通的工位 key；
   *     当前全部免费，但**不传 ≠ 空数组**：不传后端开通全部，传空数组会得到一个什么都用不了的团队）；
   *   · 凭邀请码加入 → `invite_token`（邀请码或**整条邀请链接**，后端自己会取 `?token=`）；
   *   · 向已存在团队发起加入申请 → `apply_team_name`（+ 可选 `apply_message` 留言 ≤200 字；
   *     账号建成但**不入团**，团队管理员审核通过才入团）；
   *   · 都不传 → 允许，进去后由团队页引导"创建/加入团队"。
   */
  team_name?: string;
  workstations?: string[];
  invite_token?: string;
  apply_team_name?: string;
  apply_message?: string;
}

export interface UserInfo {
  user_id: number;
  email: string;
  display_name: string;
  account_type: "internal" | "customer";
  role: string;
  plan: string;
  // 账号归属的团队（团队 / 用户 / 业务客户 三概念分开后，账号不再绑定业务客户）
  team_id: number | null;
  team_name: string | null;
  // 官网数据后台权限：由团队管理员授予成员
  console_access: boolean;
}

export interface LoginResponse extends UserInfo {
  access_token: string;
  token_type: "bearer";
}

export interface AuthState {
  user: UserInfo | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}
