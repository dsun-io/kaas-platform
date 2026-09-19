import { Sidebar } from "./sidebar";
import { Header } from "./header";

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto" style={{ background: "var(--gradient-subtle)" }}>
          <div className="page-container">{children}</div>
        </main>
      </div>
    </div>
  );
}
