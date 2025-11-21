import { NextResponse } from "next/server";

import { supabaseAdmin } from "../../../../lib/supabaseAdmin";

const STATUSES = ["NEW", "PROCESSING", "ENRICHED", "DRAFT_READY", "APPROVED", "REJECTED"] as const;

type StatusKey = (typeof STATUSES)[number];

type StatusCounts = Record<StatusKey, number>;

const createInitialCounts = (): StatusCounts => {
  return STATUSES.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {} as StatusCounts);
};

export async function GET() {
  try {
    const client = supabaseAdmin();
    const counts = createInitialCounts();

    await Promise.all(
      STATUSES.map(async (status) => {
        const { count, error } = await client
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("status", status);

        if (error) {
          throw error;
        }

        counts[status] = count ?? 0;
      })
    );

    const { data: nextLead, error: nextLeadError } = await client
      .from("leads")
      .select("id, linkedin_url, first_name, last_name, company_name")
      .in("status", ["NEW", "PROCESSING"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (nextLeadError) {
      throw nextLeadError;
    }

    // Compute progress strictly from the enrichment pipeline:
    // remaining = NEW + PROCESSING, completed = ENRICHED.
    const remaining = (counts.NEW || 0) + (counts.PROCESSING || 0);
    const completed = counts.ENRICHED || 0;

    return NextResponse.json({
      ok: true,
      counts,
      remaining,
      completed,
      nextLead: nextLead || null,
    });
  } catch (error: any) {
    console.error("/api/enrich/status error", error);
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Failed to fetch enrichment status.",
      },
      { status: 500 }
    );
  }
}
