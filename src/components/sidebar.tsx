"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useState, useEffect } from "react";
import {
  Search,
  Inbox,
  Archive,
  FolderOpen,
  Users,
  LogOut,
  Menu,
  X,
  Home,
  Tag,
} from "lucide-react";
import { QuickCreateModal } from "@/components/quick-create-modal";

interface SidebarProps {
  user: { name: string; role: string };
}

const navItems = [
  { href: "/", label: "ダッシュボード", icon: Home, exact: true },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/assets", label: "Assets", icon: Archive },
  { href: "/entities", label: "エンティティ", icon: Tag },
  { href: "/collections", label: "コレクション", icon: FolderOpen },
  { href: "/search", label: "検索", icon: Search },
];

const adminItems = [
  { href: "/admin/users", label: "ユーザー管理", icon: Users },
];

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // ページ遷移時にメニューを閉じる
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      {/* モバイルヘッダー */}
      <header className="md:hidden fixed top-0 left-0 right-0 z-40 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <button
          onClick={() => setOpen(!open)}
          className="p-1 -ml-1 text-slate-600 hover:text-slate-900"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
        <img src="/icon-96.jpg" alt="" className="w-6 h-6 rounded-md" />
        <span className="text-sm font-bold tracking-tight">Akashic</span>
        <QuickCreateModal />
      </header>

      {/* オーバーレイ */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/30"
          onClick={() => setOpen(false)}
        />
      )}

      {/* サイドバー本体 */}
      <aside
        className={`
          fixed md:static z-50 top-0 left-0 h-full w-56
          flex flex-col border-r border-slate-200 bg-white
          transition-transform duration-200 ease-in-out
          ${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0
        `}
      >
        <div className="border-b border-slate-200 px-4 py-3 flex items-center gap-2.5">
          <img src="/icon-96.jpg" alt="" className="w-8 h-8 rounded-md" />
          <div>
            <h1 className="text-sm font-bold tracking-tight leading-tight">Akashic</h1>
            <p className="text-xs text-slate-500 leading-tight">Sekai Nina</p>
          </div>
        </div>
        {/* Search bar + New asset */}
        <div className="px-3 py-2 border-b border-slate-200 space-y-2">
          <form
            action="/search"
            method="GET"
            className="relative"
          >
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              name="q"
              placeholder="検索..."
              className="w-full bg-slate-50 border border-slate-200 rounded-md pl-8 pr-3 py-1.5 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white"
            />
          </form>
          <QuickCreateModal />
        </div>
        <nav className="flex-1 space-y-1 px-2 py-3">
          {navItems.map((item) => {
            const active = "exact" in item && item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href);
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
            onClick={handleSignOut}
            className="mt-1 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
          >
            <LogOut size={12} />
            ログアウト
          </button>
        </div>
      </aside>
    </>
  );
}
