import { NavLink, Outlet } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded text-sm font-medium ${
    isActive ? "bg-gray-800 text-white" : "text-gray-300 hover:bg-gray-800 hover:text-white"
  }`;

export function PageShell() {
  const title = usePageTitle();

  return (
    <div className="flex h-screen">
      <aside className="w-56 bg-gray-900 flex flex-col">
        <div className="px-4 py-4 text-white font-bold text-lg tracking-tight">
          Liffy
        </div>
        <nav className="flex flex-col gap-1 px-2" aria-label="Primary">
          <NavLink to="/" end className={navLinkClass}>
            Dashboard
          </NavLink>
          <NavLink to="/reviews" className={navLinkClass}>
            Reviews
          </NavLink>
        </nav>
      </aside>

      <div className="flex flex-col flex-1">
        <header className="h-14 border-b border-gray-200 flex items-center px-6">
          <h2 className="text-base font-semibold">{title}</h2>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
