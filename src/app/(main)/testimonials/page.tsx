import { prisma } from "@/lib/db";
import { TestimonialList } from "./testimonial-list";
import Link from "next/link";

const PAGE_SIZE = 30;

export default async function TestimonialsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1"));
  const statusFilter = params.status || "pending";

  const where = statusFilter === "all" ? {} : { status: statusFilter as "pending" | "approved" | "rejected" };

  const [testimonials, total] = await Promise.all([
    prisma.testimonial.findMany({
      where,
      orderBy: [{ confidence: "desc" }, { sourceDate: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.testimonial.count({ where }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const serialized = testimonials.map((t) => ({
    id: t.id,
    quote: t.quote,
    trait: t.trait,
    category: t.category,
    speakerName: t.speakerName,
    sourceUrl: t.sourceUrl,
    sourceDate: t.sourceDate?.toISOString() ?? null,
    status: t.status,
    confidence: t.confidence,
  }));

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">口コミ管理</h1>
        <p className="text-slate-500 text-sm mt-1">
          性格・人柄の抽出結果をレビュー — {total} 件
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 mb-4">
        {["pending", "approved", "rejected", "all"].map((s) => (
          <Link
            key={s}
            href={`/testimonials?status=${s}`}
            className={`px-3 py-1 rounded-full text-sm ${
              statusFilter === s
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {s === "pending" ? "未レビュー" : s === "approved" ? "承認済" : s === "rejected" ? "却下" : "全て"}
          </Link>
        ))}
      </div>

      <TestimonialList items={serialized} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-slate-500">
            {page} / {totalPages} ページ
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/testimonials?status=${statusFilter}&page=${page - 1}`}
                className="px-3 py-1 text-sm bg-slate-100 rounded hover:bg-slate-200"
              >
                前へ
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/testimonials?status=${statusFilter}&page=${page + 1}`}
                className="px-3 py-1 text-sm bg-slate-100 rounded hover:bg-slate-200"
              >
                次へ
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
