import { getInvitationByToken } from "@/lib/domain/invitations";
import { InviteForm } from "./invite-form";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const invitation = await getInvitationByToken(token);

  if (!invitation) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm text-center">
          <h1 className="mb-2 text-xl font-bold text-slate-900">招待が無効です</h1>
          <p className="text-sm text-slate-500">
            この招待リンクは期限切れ、使用済み、または無効です。
          </p>
          <a
            href="/login"
            className="mt-4 inline-block text-sm text-blue-600 hover:text-blue-800"
          >
            ログインページへ
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <img src="/icon.jpg" alt="" className="w-12 h-12 rounded-lg mb-4" />
        <h1 className="mb-1 text-xl font-bold">アカウント作成</h1>
        <p className="mb-6 text-sm text-slate-500">
          Sekai Nina Akashic への招待を受け取りました
        </p>
        <InviteForm token={token} email={invitation.email ?? undefined} />
      </div>
    </div>
  );
}
