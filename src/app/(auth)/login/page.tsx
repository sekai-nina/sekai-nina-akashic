"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";

const ERROR_MESSAGES: Record<string, string> = {
  no_invite: "アカウントが見つかりません。招待リンクからアカウントを作成してください。",
  invalid_invite: "招待が無効です。管理者にお問い合わせください。",
  email_mismatch: "この招待は別のメールアドレス向けです。",
  auth_failed: "認証に失敗しました。もう一度お試しください。",
  no_code: "認証コードがありません。",
  no_email: "メールアドレスを取得できませんでした。",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const registered = searchParams.get("registered");
  const errorParam = searchParams.get("error");
  const serverError = errorParam ? ERROR_MESSAGES[errorParam] ?? "エラーが発生しました" : "";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const formData = new FormData(e.currentTarget);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: formData.get("email") as string,
      password: formData.get("password") as string,
    });
    setLoading(false);
    if (error) {
      setError("メールアドレスまたはパスワードが正しくありません");
    } else {
      router.push("/search");
      router.refresh();
    }
  }

  async function handleDiscordLogin() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback`,
        scopes: "identify email",
      },
    });
  }

  return (
    <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
      <img src="/icon.jpg" alt="" className="w-12 h-12 rounded-lg mb-4" />
      <h1 className="mb-1 text-xl font-bold">Sekai Nina Akashic</h1>
      <p className="mb-6 text-sm text-slate-500">ログイン</p>

      {registered && (
        <p className="mb-4 text-sm text-green-600 bg-green-50 rounded-md p-2">
          アカウントが作成されました。ログインしてください。
        </p>
      )}
      {serverError && (
        <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-md p-2">{serverError}</p>
      )}

      {/* Discord OAuth */}
      <button
        onClick={handleDiscordLogin}
        className="w-full rounded-md bg-[#5865F2] px-4 py-2 text-sm font-medium text-white hover:bg-[#4752C4] transition-colors flex items-center justify-center gap-2 mb-4"
      >
        <svg width="16" height="12" viewBox="0 0 71 55" fill="currentColor">
          <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3## 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978Z" />
        </svg>
        Discord でログイン
      </button>

      <div className="relative mb-4">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-slate-200" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-white px-2 text-slate-400">または</span>
        </div>
      </div>

      {/* Email/password */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">メールアドレス</label>
          <input
            name="email"
            type="email"
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">パスワード</label>
          <input
            name="password"
            type="password"
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? "ログイン中…" : "メールでログイン"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Suspense fallback={<div className="w-full max-w-sm h-96" />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
