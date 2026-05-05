/** Auth types — aligned with backend POST /api/v1/auth/login & GET /api/v1/auth/me */

export interface LoginRequest {
  email: string;
  password: string;
}

export interface UserInfo {
  user_id: number;
  email: string;
  display_name: string;
  account_type: "internal" | "customer";
  customer_id: number | null;
  customer_code: string | null;
  customer_name: string | null;
  tenant_id: string | null;
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
