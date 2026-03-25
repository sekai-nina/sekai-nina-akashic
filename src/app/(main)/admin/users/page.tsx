import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createUser, updateUser, deleteUser } from "@/lib/actions";
import { formatDate } from "@/lib/utils";
import { redirect } from "next/navigation";


const ROLE_LABELS: Record<string, string> = {
  admin: "管理者",
  member: "メンバー",
  viewer: "閲覧者",
};

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin: "bg-red-100 text-red-700",
    member: "bg-blue-100 text-blue-700",
    viewer: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[role] ?? "bg-slate-100 text-slate-600"}`}>
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    redirect("/inbox");
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">ユーザー管理</h1>
        <p className="text-slate-500 text-sm mt-1">システムユーザーの管理</p>
      </div>

      {/* Create user form */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">新規ユーザー作成</h2>
        <form action={createUser} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">メールアドレス <span className="text-red-500">*</span></label>
              <input
                type="email"
                name="email"
                required
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">名前 <span className="text-red-500">*</span></label>
              <input
                type="text"
                name="name"
                required
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="山田 太郎"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">パスワード <span className="text-red-500">*</span></label>
              <input
                type="password"
                name="password"
                required
                minLength={8}
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">ロール</label>
              <select
                name="role"
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="member">メンバー</option>
                <option value="viewer">閲覧者</option>
                <option value="admin">管理者</option>
              </select>
            </div>
          </div>
          <button
            type="submit"
            className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            ユーザーを作成
          </button>
        </form>
      </div>

      {/* User list */}
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {users.map((user) => {
          const updateAction = updateUser.bind(null, user.id);
          const deleteAction = deleteUser.bind(null, user.id);
          const isSelf = user.id === session.user.id;

          return (
            <div key={user.id} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-800">{user.name}</span>
                <RoleBadge role={user.role} />
                {isSelf && <span className="text-xs text-slate-300">(自分)</span>}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className="truncate">{user.email}</span>
                <span className="shrink-0">{formatDate(user.createdAt)}</span>
              </div>
              <div className="flex items-center gap-2">
                <details className="relative">
                  <summary className="text-xs text-blue-600 hover:text-blue-800 cursor-pointer list-none">
                    編集
                  </summary>
                  <div className="absolute left-0 top-6 z-10 bg-white border border-slate-200 rounded-lg shadow-lg p-4 w-72">
                    <h3 className="text-xs font-semibold text-slate-700 mb-3">ユーザー編集: {user.name}</h3>
                    <form action={updateAction} className="space-y-2">
                      <div>
                        <label className="block text-xs text-slate-500 mb-0.5">メール</label>
                        <input
                          type="email"
                          name="email"
                          defaultValue={user.email}
                          required
                          className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-0.5">名前</label>
                        <input
                          type="text"
                          name="name"
                          defaultValue={user.name}
                          required
                          className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-0.5">新しいパスワード（変更する場合）</label>
                        <input
                          type="password"
                          name="password"
                          className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-0.5">ロール</label>
                        <select
                          name="role"
                          defaultValue={user.role}
                          className="w-full border border-slate-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="member">メンバー</option>
                          <option value="viewer">閲覧者</option>
                          <option value="admin">管理者</option>
                        </select>
                      </div>
                      <button
                        type="submit"
                        className="bg-blue-600 text-white px-3 py-1 rounded text-xs hover:bg-blue-700 transition-colors"
                      >
                        保存
                      </button>
                    </form>
                  </div>
                </details>

                {!isSelf && (
                  <form action={deleteAction}>
                    <button
                      type="submit"
                      className="text-xs text-red-400 hover:text-red-600"
                    >
                      削除
                    </button>
                  </form>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-slate-400 mt-4">
        合計 {users.length} ユーザー
      </p>
    </div>
  );
}
