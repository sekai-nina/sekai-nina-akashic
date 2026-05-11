import { auth } from "@/lib/auth";
import { listInvitations } from "@/lib/domain/invitations";
import { createInvitationAction, deleteInvitationAction } from "@/lib/actions";
import { formatDate } from "@/lib/utils";
import { redirect } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";
import { CopyInviteLink } from "./copy-invite-link";

const ROLE_LABELS: Record<string, string> = {
  admin: "管理者",
  member: "メンバー",
  viewer: "閲覧者",
};

const CLEARANCE_LABELS: Record<string, string> = {
  public: "公開",
  internal: "一般",
  confidential: "限定",
  restricted: "極秘",
};

const CLEARANCE_COLORS: Record<string, string> = {
  public: "bg-green-100 text-green-700",
  internal: "bg-blue-100 text-blue-700",
  confidential: "bg-orange-100 text-orange-700",
  restricted: "bg-red-100 text-red-700",
};

export default async function AdminInvitationsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    redirect("/inbox");
  }

  const invitations = await listInvitations();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">招待管理</h1>
        <p className="text-slate-500 text-sm mt-1">招待リンクの作成と管理</p>
      </div>

      {/* Create invitation form */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 mb-6">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">新規招待を作成</h2>
        <form action={createInvitationAction} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">メールアドレス（任意）</label>
              <input
                type="email"
                name="email"
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="特定のメールに制限する場合"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">有効期間（日）</label>
              <input
                type="number"
                name="expiresInDays"
                defaultValue={7}
                min={1}
                max={90}
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
            <div>
              <label className="block text-xs text-slate-500 mb-1">クリアランスレベル</label>
              <select
                name="clearance"
                className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="internal" selected>一般</option>
                <option value="confidential">限定</option>
                <option value="restricted">極秘</option>
              </select>
            </div>
          </div>
          <SubmitButton className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-medium hover:bg-blue-700 transition-colors">
            招待を作成
          </SubmitButton>
        </form>
      </div>

      {/* Invitation list */}
      <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
        {invitations.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slate-400">
            招待がありません
          </div>
        )}
        {invitations.map((inv) => {
          const isExpired = inv.expiresAt < new Date();
          const isUsed = !!inv.usedAt;
          const isActive = !isExpired && !isUsed;
          const deleteAction = deleteInvitationAction.bind(null, inv.id);
          const inviteUrl = `${baseUrl}/invite/${inv.token}`;

          return (
            <div key={inv.id} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                {isUsed ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-500">
                    使用済み
                  </span>
                ) : isExpired ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-red-500">
                    期限切れ
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                    有効
                  </span>
                )}
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${CLEARANCE_COLORS[inv.clearance] ?? ""}`}>
                  {CLEARANCE_LABELS[inv.clearance] ?? inv.clearance}
                </span>
                <span className="text-xs text-slate-500">
                  {ROLE_LABELS[inv.role] ?? inv.role}
                </span>
                {inv.email && (
                  <span className="text-xs text-slate-400 truncate">→ {inv.email}</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span>作成: {inv.createdBy.name}</span>
                <span>期限: {formatDate(inv.expiresAt)}</span>
                {inv.usedBy && <span>使用者: {inv.usedBy.name}</span>}
              </div>
              <div className="flex items-center gap-3 text-xs">
                {isActive && <CopyInviteLink url={inviteUrl} />}
                {!isUsed && (
                  <form action={deleteAction}>
                    <SubmitButton className="text-red-400 hover:text-red-600">
                      取消
                    </SubmitButton>
                  </form>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-slate-400 mt-4">
        合計 {invitations.length} 件
      </p>
    </div>
  );
}
