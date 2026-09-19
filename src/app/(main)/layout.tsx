import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { getCachedClipCount } from "@/lib/cache";
import type { ClearanceLevel } from "@prisma/client";
import { NavigationProgress } from "@/components/navigation-progress";
import { QuickCreateModal } from "@/components/quick-create-modal";
import { CoverageScrollMemory } from "./coverage/scroll-memory";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // サイドバーの「クリップ」バッジ (#41)。30 秒キャッシュなので毎ページの往復にはならない。
  // 失敗してもページは出す
  const clipCount = await getCachedClipCount(session.user.clearance as ClearanceLevel).catch((e: unknown) => {
    console.error("クリップ件数の取得に失敗:", e);
    return 0;
  });

  return (
    <div className="flex h-dvh">
      <Suspense>
        <NavigationProgress />
      </Suspense>
      <Suspense>
        <CoverageScrollMemory />
      </Suspense>
      <Sidebar user={session.user} clipCount={clipCount} />
      <main className="flex-1 overflow-auto mt-12 md:mt-0">
        <div className="px-4 pt-2 pb-24 md:px-6 md:pt-6 md:pb-6">{children}</div>
      </main>
      <QuickCreateModal variant="fab" />
    </div>
  );
}
