import { Sidebar } from "./sidebar";
import { Header } from "./header";

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-backdrop relative flex h-screen flex-col overflow-hidden lg:flex-row">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <main className="relative flex-1 overflow-auto">
          <div className="page-container">{children}</div>
        </main>
      </div>
    </div>
  );
}
