import { DraftFeed } from "../components/DraftFeed";
import { LeadList } from "../components/LeadList";
import { fetchDraftFeed, fetchLeadList } from "./actions";
import type { OutreachMode } from "../lib/outreachModes";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  searchParams?: {
    outreachMode?: OutreachMode;
  };
};

export default async function MissionControlPage({ searchParams }: PageProps) {
  const outreachMode: OutreachMode = searchParams?.outreachMode === "message_only" ? "message_only" : "connect_message";
  const leadStatuses = outreachMode === "message_only"
    ? ["CONNECT_ONLY_SENT"]
    : ["ENRICHED", "DRAFT_READY", "APPROVED"];

  const [drafts, leadResult] = await Promise.all([
    fetchDraftFeed(outreachMode),
    fetchLeadList(1, 50, { statuses: leadStatuses }),
  ]);

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18, gap: 14 }}>
        <div>
          <div className="pill">Draft Feed</div>
          <h1 style={{ margin: "12px 0 6px 0", fontSize: 32, letterSpacing: "-0.5px" }}>
            Mission Control
          </h1>
          <div className="muted">Review, edit, and approve AI-generated outreach.</div>
          <div style={{ marginTop: 6 }}>
            <a className="muted" href="/leads">
              View all leads →
            </a>
          </div>
          <div style={{ marginTop: 4 }}>
            <a className="muted" href="/settings">
              Set LinkedIn credentials →
            </a>
          </div>
        </div>
      </div>

      <LeadList
        leads={leadResult.leads}
        condensed
        maxRows={8}
        initialFilters={{ status: outreachMode === "message_only" ? "CONNECT_ONLY_SENT" : "ENRICHED" }}
      />

      <DraftFeed drafts={drafts} initialOutreachMode={outreachMode} />
    </div>
  );
}
