import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { NavigationProgress } from "@/components/navigation-progress";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="flex h-screen">
      <Suspense>
        <NavigationProgress />
      </Suspense>
      <Sidebar user={session.user} />
      <main className="flex-1 overflow-auto p-4 pt-14 pb-24 md:p-6 md:pt-6 md:pb-6">{children}</main>
    </div>
  );
}
