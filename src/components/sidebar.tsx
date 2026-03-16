"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Search,
  Inbox,
  Archive,
  FolderOpen,
  Users,
  LogOut,
} from "lucide-react";

interface SidebarProps {
  user: { name: string; role: string };
}

const navItems = [
  { href: "/search", label: "検索", icon: Search },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/assets", label: "Assets", icon: Archive },
  { href: "/collections", label: "コレクション", icon: FolderOpen },
];

const adminItems = [
  { href: "/admin/users", label: "ユーザー管理", icon: Users },
];

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-4">
        <h1 className="text-sm font-bold tracking-tight">Akashic</h1>
        <p className="text-xs text-slate-500">Sekai Nina</p>
      </div>
      <nav className="flex-1 space-y-1 px-2 py-3">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                active
                  ? "bg-slate-100 font-medium text-slate-900"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              <item.icon size={16} />
              {item.label}
            </Link>
          );
        })}
        {user.role === "admin" && (
          <>
            <div className="mx-3 my-2 border-t border-slate-100" />
            {adminItems.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                    active
                      ? "bg-slate-100 font-medium text-slate-900"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  <item.icon size={16} />
                  {item.label}
                </Link>
              );
            })}
          </>
        )}
      </nav>
      <div className="border-t border-slate-200 px-4 py-3">
        <p className="text-xs font-medium">{user.name}</p>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="mt-1 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <LogOut size={12} />
          ログアウト
        </button>
      </div>
    </aside>
  );
}
