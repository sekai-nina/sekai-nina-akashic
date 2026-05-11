"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";

export default function MfaSetupPage() {
  const router = useRouter();
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [factorId, setFactorId] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [enrolling, setEnrolling] = useState(true);

  useEffect(() => {
    async function enroll() {
      const supabase = createClient();
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Akashic TOTP",
      });

      if (error || !data) {
        setError("MFA の設定に失敗しました。もう一度お試しください。");
        setEnrolling(false);
        return;
      }

      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
      setFactorId(data.id);
      setEnrolling(false);
    }
    enroll();
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
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
      setError("コードが正しくありません。もう一度お試しください。");
    } else {
      router.push("/search");
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-bold">二段階認証の設定</h1>
        <p className="mb-6 text-sm text-slate-500">
          認証アプリ（Google Authenticator 等）で QR コードをスキャンしてください
        </p>

        {enrolling && (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-900" />
          </div>
        )}

        {!enrolling && qrCode && (
          <>
            <div className="flex justify-center mb-4">
              <img src={qrCode} alt="TOTP QR Code" className="w-48 h-48" />
            </div>

            <details className="mb-4">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                QR コードをスキャンできない場合
              </summary>
              <div className="mt-2 p-2 bg-slate-50 rounded text-xs font-mono break-all">
                {secret}
              </div>
            </details>

            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">確認コード</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  required
                  autoFocus
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-center tracking-widest focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                  placeholder="000000"
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {loading ? "確認中…" : "設定を完了"}
              </button>
            </form>
          </>
        )}

        {!enrolling && !qrCode && error && (
          <div className="text-center">
            <p className="text-sm text-red-600 mb-4">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              再試行
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
