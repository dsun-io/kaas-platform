import fs from 'node:fs';
import path from 'node:path';

/**
 * 导出态 e2e 的全局准备（2026-10-22）
 *
 * 与 `e2e/global-setup.ts` 的差别只有两处，且都是必须的：
 *   ① origin 换成静态服务器 `http://localhost:4173`（`origin`/`cookie domain` 都是 origin 作用域的，
 *      照抄 3000 会让 localStorage 里的 token 注入到错误 origin ⇒ AuthProvider 恢复不出 user）；
 *   ② storageState 落到 `e2e-export/.auth/state.json`，与 dev 态 e2e 的 state 互不干扰。
 *
 * 这里只种"已登录"的最小状态（cookie + token），假数据层由 MSW 提供：
 *   · `has_token` 让 `(app)/layout` 的 AuthGate 放行；
 *   · `kaas_token` 让 AuthProvider 去调 `/auth/me`（mock 里固定返回管理员）。
 */
export default async function globalSetup() {
  const authDir = path.join(__dirname, '.auth');
  fs.mkdirSync(authDir, { recursive: true });

  const state = {
    cookies: [
      {
        name: 'has_token',
        value: '1',
        domain: 'localhost',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin: 'http://localhost:4173',
        localStorage: [{ name: 'kaas_token', value: 'mock-access-token' }],
      },
    ],
  };

  fs.writeFileSync(path.join(authDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}
