"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";

export default function MfaVerifyPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [factorId, setFactorId] = useState<string | null>(null);

  useEffect(() => {
    async function getFactors() {
      const supabase = createClient();
      const { data } = await supabase.auth.mfa.listFactors();
      const totp = data?.totp?.[0];
      if (totp) {
        setFactorId(totp.id);
      } else {
        // No MFA enrolled — redirect to setup
        router.replace("/mfa/setup");
      }
    }
    getFactors();
  }, [router]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setLoading(true);
    setError("");

    const supabase = createClient();

    const { data: challenge, error: challengeError } =
      await supabase.auth.mfa.challenge({ factorId });
    if (challengeError || !challenge) {
      setError("チャレンジの作成に失敗しました");
      setLoading(false);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code,
    });

    setLoading(false);
    if (verifyError) {
      setError("コードが正しくありません");
      setCode("");
    } else {
      router.push("/search");
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <img src="/icon.jpg" alt="" className="w-12 h-12 rounded-lg mb-4" />
        <h1 className="mb-1 text-xl font-bold">二段階認証</h1>
        <p className="mb-6 text-sm text-slate-500">
          認証アプリに表示されているコードを入力してください
        </p>

        <form onSubmit={handleVerify} className="space-y-4">
          <div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              required
              autoFocus
              className="w-full rounded-md border border-slate-300 px-3 py-3 text-lg text-center tracking-[0.5em] focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              placeholder="000000"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading || code.length !== 6 || !factorId}
            className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "確認中…" : "確認"}
          </button>
        </form>
      </div>
    </div>
  );
}
