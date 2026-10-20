import { Sidebar } from "./sidebar";
import { Header } from "./header";

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-backdrop relative flex h-screen flex-col overflow-hidden lg:flex-row">
      {/* a11y（C26/A10）：键盘用户第一个 Tab 即可跳过侧栏导航直达主内容。
          默认 sr-only，获得焦点时浮出；目标 `main#main` 必须带 tabIndex=-1 才能接管焦点
          （只写 id 时多数浏览器只滚动、不移动焦点）。 */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:border focus:border-white/70 focus:bg-white/95 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        跳到主内容
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <main
          id="main"
          tabIndex={-1}
          className="relative flex-1 overflow-auto outline-none"
        >
          <div className="page-container">{children}</div>
        </main>
      </div>
    </div>
  );
}
