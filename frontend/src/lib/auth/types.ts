/** Auth types — aligned with backend POST /api/v1/auth/login, /register, GET /api/v1/auth/me */

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  display_name: string;
  company_name: string;
  product_category: string;
  contact?: string;
  /**
   * 团队动作（可选，**互斥二选一**）：
   *   · 新建团队 → `team_name`（注册者即团队管理员）+ `workstations`（要开通的工位 key；
   *     当前全部免费，但**不传 ≠ 空数组**：不传后端开通全部，传空数组会得到一个什么都用不了的团队）；
   *   · 加入团队 → `invite_token`（邀请码或**整条邀请链接**，后端自己会取 `?token=`）；
   *   · 都不传 → 允许，进去后由团队页引导"创建/加入团队"。
   */
  team_name?: string;
  workstations?: string[];
  invite_token?: string;
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
