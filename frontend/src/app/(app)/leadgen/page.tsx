"use client";

import { useState } from "react";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, StatusBadge, SectionCard, EmptyState } from "@/components/shared";
import { toast } from "sonner";
import { Play, ShieldCheck, RefreshCw } from "lucide-react";

/* ── types ─────────────────────────────────────────────────────────────── */
interface LeadgenRun {
  id: number;
  status: string;
  leads_found: number | null;
  leads_kept: number | null;
  error: string | null;
  deduplicated?: boolean;
  started_at: string | null;
  finished_at: string | null;
}

interface Lead {
  id: number;
  place_id: string | null;
  company_name: string;
  country: string | null;
  region: string | null;
  city: string | null;
  email: string | null;
  website: string | null;
  phone: string | null;
  industry: string | null;
  google_rating: number | null;
  google_reviews: number | null;
  fit_score: number | null;
  fit_reasons: string[] | null;
  opening_line: string | null;
  outreach_status: string;
  inquiry_status: string;
  demand_index: number | null;
  blank_index: number | null;
  created_at: string;
}

interface LeadDetail extends Lead {
  outreach_history: { id: number; status: string; error: string | null; sent_at: string | null }[];
  inquiry_history: { id: number; status: string; created_at: string }[];
}

const OUTREACH_TONES: Record<string, import("@/components/shared").StatusTone> = {
  none: "default", pending: "default", sent: "info", delivered: "info",
  opened: "purple", replied: "success", bounced: "danger",
};
const INQUIRY_TONES: Record<string, import("@/components/shared").StatusTone> = {
  none: "default", new: "info", following: "purple", won: "success", lost: "danger",
};

function scoreTone(score: number | null): import("@/components/shared").StatusTone {
  if (score == null) return "default";
  if (score >= 75) return "success";
  if (score >= 50) return "info";
  return "default";
}

/* ── page ──────────────────────────────────────────────────────────────── */
export default function LeadgenPage() {
  usePageView({ resource_id: "/leadgen" });
  const qc = useQueryClient();
  const [cfg, setCfg] = useState({ region: "", industry: "", icp: "", quantity: 20, source: "demo" });
  const [validating, setValidating] = useState(false);
  const [running, setRunning] = useState(false);
  const [validation, setValidation] = useState<{ valid: boolean; issues: string[]; path: string } | null>(null);
  const [search, setSearch] = useState("");
  const [outreachFilter, setOutreachFilter] = useState("");
  const [inquiryFilter, setInquiryFilter] = useState("");
  const [sort, setSort] = useState("score");
  const [detail, setDetail] = useState<LeadDetail | null>(null);

  const { data: regionsData } = useQuery({
    queryKey: ["leadgen-regions"],
    queryFn: async () => (await apiClient.get<{ items: string[] }>("/leadgen/regions")).data,
  });
  const regions = regionsData?.items ?? [];

  const { data: runsData, refetch: refetchRuns } = useQuery({
    queryKey: ["leadgen-runs"],
    queryFn: async () => (await apiClient.get<{ items: LeadgenRun[] }>("/leadgen/runs")).data,
  });

  const leadsQuery = useQuery({
    queryKey: ["leads", search, outreachFilter, inquiryFilter, sort],
    queryFn: async () => {
      const params = new URLSearchParams({ sort, page_size: "100" });
      if (search) params.set("search", search);
      if (outreachFilter) params.set("outreach_status", outreachFilter);
      if (inquiryFilter) params.set("inquiry_status", inquiryFilter);
      return (await apiClient.get<{ items: Lead[]; total: number }>(`/leads?${params}`)).data;
    },
  });
  const leads = leadsQuery.data?.items ?? [];

  const validate = async () => {
    setValidating(true);
    try {
      const { data } = await apiClient.post<{ result: { valid: boolean; issues: string[] }; path: string }>(
        "/leadgen/validate",
        { region: cfg.region, industry: cfg.industry, icp: cfg.icp || null, quantity: cfg.quantity, source: cfg.source },
      );
      setValidation({ ...data.result, path: data.path });
    } catch (e) {
      toast.error("Validation failed");
    } finally {
      setValidating(false);
    }
  };

  const run = async () => {
    setRunning(true);
    try {
      const { data } = await apiClient.post<LeadgenRun>("/leadgen/runs", {
        region: cfg.region, industry: cfg.industry, icp: cfg.icp || null,
        quantity: cfg.quantity, source: cfg.source,
      });
      if (data.deduplicated) toast.info("Same config already ran — returning previous result");
      else toast.success(`Run finished: ${data.leads_kept ?? 0} new leads kept`);
      qc.invalidateQueries({ queryKey: ["leads"] });
      refetchRuns();
    } catch (e) {
      toast.error("Run failed");
    } finally {
      setRunning(false);
    }
  };

  const scanReplied = async () => {
    try {
      const { data } = await apiClient.post<{ scanned: number; created: number }>("/leads/scan-replied");
      toast.success(`Scanned ${data.scanned} replied leads, created ${data.created} inquiries`);
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (e) {
      toast.error("Scan failed");
    }
  };

  const openDetail = async (id: number) => {
    const { data } = await apiClient.get<LeadDetail>(`/leads/${id}`);
    setDetail(data);
  };

  const setNum = (v: string) => setCfg({ ...cfg, quantity: Math.max(1, parseInt(v || "1", 10)) });

  return (
    <RouteGuard>
      <PageHeader title="Lead Generation" description="Fetch prospects, AI-score them into the shared lead pool" />
      <div className="space-y-6 p-6">
        {/* config */}
        <SectionCard title="Fetch Config">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <select className="rounded-md border bg-background px-3 py-2 text-sm" value={cfg.source}
              onChange={(e) => setCfg({ ...cfg, source: e.target.value })}>
              <option value="demo">Demo source</option>
              <option value="csv">CSV import</option>
            </select>
            <select className="rounded-md border bg-background px-3 py-2 text-sm" value={cfg.region}
              onChange={(e) => setCfg({ ...cfg, region: e.target.value })}>
              <option value="">All regions</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Input placeholder="Industry keyword" value={cfg.industry}
              onChange={(e) => setCfg({ ...cfg, industry: e.target.value })} />
            <Input placeholder="ICP note (optional)" value={cfg.icp}
              onChange={(e) => setCfg({ ...cfg, icp: e.target.value })} />
            <Input type="number" min={1} value={cfg.quantity} onChange={(e) => setNum(e.target.value)} />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={validate} disabled={validating}>
              <ShieldCheck className="mr-1 h-4 w-4" /> Validate
            </Button>
            <Button size="sm" onClick={run} disabled={running}>
              <Play className="mr-1 h-4 w-4" /> {running ? "Running…" : "Run fetch"}
            </Button>
            <Button variant="outline" size="sm" onClick={scanReplied}>
              <RefreshCw className="mr-1 h-4 w-4" /> Scan replied → inquiries
            </Button>
            {validation && (
              <div className="flex items-center gap-2 text-sm">
                {validation.valid
                  ? <Badge className="bg-green-100 text-green-800">Config OK ({validation.path})</Badge>
                  : <Badge className="bg-red-100 text-red-800">{validation.issues.length} issue(s): {validation.issues.join("; ")}</Badge>}
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            CSV import uses POST /leadgen/runs/from-csv (multipart). Google Places source is planned.
          </p>
        </SectionCard>

        {/* runs history */}
        <SectionCard title="Run History">
          {(runsData?.items ?? []).length === 0 ? (
            <EmptyState title="No runs yet" />
          ) : (
            <div className="space-y-1 text-sm">
              {(runsData?.items ?? []).slice(0, 10).map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded border px-3 py-2">
                  <StatusBadge tone={r.status === "succeeded" ? "success" : r.status === "failed" ? "danger" : "info"}>{r.status}</StatusBadge>
                  <span className="text-muted-foreground">#{r.id}</span>
                  <span>found {r.leads_found ?? "-"}</span>
                  <span>kept {r.leads_kept ?? "-"}</span>
                  {r.deduplicated && <Badge variant="outline">deduplicated</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">{r.started_at?.slice(0, 19) ?? ""}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* lead pool */}
        <SectionCard title={`Lead Pool (${leadsQuery.data?.total ?? 0})`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input className="w-56" placeholder="Search company / city…" value={search}
              onChange={(e) => setSearch(e.target.value)} />
            <select className="rounded-md border bg-background px-3 py-2 text-sm" value={outreachFilter}
              onChange={(e) => setOutreachFilter(e.target.value)}>
              <option value="">Outreach: all</option>
              {["none", "sent", "delivered", "opened", "replied", "bounced"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="rounded-md border bg-background px-3 py-2 text-sm" value={inquiryFilter}
              onChange={(e) => setInquiryFilter(e.target.value)}>
              <option value="">Inquiry: all</option>
              {["new", "following", "won", "lost"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="rounded-md border bg-background px-3 py-2 text-sm" value={sort}
              onChange={(e) => setSort(e.target.value)}>
              <option value="score">Sort: fit score</option>
              <option value="recent">Sort: recent</option>
              <option value="name">Sort: name</option>
            </select>
          </div>

          {leads.length === 0 ? (
            <EmptyState title="No leads" description="Run a fetch to fill the pool" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">Company</th>
                    <th className="p-2">Location</th>
                    <th className="p-2">Score</th>
                    <th className="p-2">Outreach</th>
                    <th className="p-2">Inquiry</th>
                    <th className="p-2">Demand (P6)</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr key={l.id} className="border-b hover:bg-muted/40">
                      <td className="p-2">
                        <div className="font-medium">{l.company_name}</div>
                        <div className="text-xs text-muted-foreground">{l.email ?? "—"}</div>
                      </td>
                      <td className="p-2 text-xs">{[l.city, l.region, l.country].filter(Boolean).join(", ") || "—"}</td>
                      <td className="p-2"><StatusBadge tone={scoreTone(l.fit_score)}>{l.fit_score ?? "—"}</StatusBadge></td>
                      <td className="p-2"><StatusBadge tone={OUTREACH_TONES[l.outreach_status] ?? "default"}>{l.outreach_status}</StatusBadge></td>
                      <td className="p-2"><StatusBadge tone={INQUIRY_TONES[l.inquiry_status] ?? "default"}>{l.inquiry_status}</StatusBadge></td>
                      <td className="p-2 text-xs text-muted-foreground">{l.demand_index ?? "—"}</td>
                      <td className="p-2"><Button variant="ghost" size="sm" onClick={() => openDetail(l.id)}>Detail</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* detail panel */}
          {detail && (
            <div className="mt-4 rounded-md border p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold">{detail.company_name}</h3>
                <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Close</Button>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
                <div><span className="text-muted-foreground">Website:</span> {detail.website ? <a className="text-blue-600 underline" href={detail.website} target="_blank" rel="noreferrer">{detail.website}</a> : "—"}</div>
                <div><span className="text-muted-foreground">Phone:</span> {detail.phone ?? "—"}</div>
                <div><span className="text-muted-foreground">Industry:</span> {detail.industry ?? "—"}</div>
                <div><span className="text-muted-foreground">Google:</span> {detail.google_rating ?? "—"} ({detail.google_reviews ?? 0} reviews)</div>
                <div><span className="text-muted-foreground">Fit reasons:</span> {(detail.fit_reasons ?? []).join(", ") || "—"}</div>
                <div><span className="text-muted-foreground">Place ID:</span> {detail.place_id ?? "—"}</div>
              </div>
              {detail.opening_line && (
                <div className="mt-3 rounded bg-muted p-2 text-sm italic">“{detail.opening_line}”</div>
              )}
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Outreach history (read-only, owned by Outreach)</div>
                  {detail.outreach_history.length === 0 ? <div className="text-xs text-muted-foreground">None</div> :
                    detail.outreach_history.map((m) => (
                      <div key={m.id} className="flex gap-2 text-xs">
                        <StatusBadge tone={OUTREACH_TONES[m.status] ?? "default"}>{m.status}</StatusBadge>
                        <span className="text-muted-foreground">{m.sent_at?.slice(0, 19) ?? ""}</span>
                        {m.error && <span className="text-red-600">{m.error}</span>}
                      </div>
                    ))}
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Inquiry history (read-only, owned by Pipeline)</div>
                  {detail.inquiry_history.length === 0 ? <div className="text-xs text-muted-foreground">None</div> :
                    detail.inquiry_history.map((i) => (
                      <div key={i.id} className="flex gap-2 text-xs">
                        <StatusBadge tone={INQUIRY_TONES[i.status] ?? "default"}>{i.status}</StatusBadge>
                        <span className="text-muted-foreground">inquiry #{i.id} · {i.created_at.slice(0, 19)}</span>
                      </div>
                    ))}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Lead pool fields (score, contact info) are editable via PATCH /leads/{detail.id}; outreach/inquiry statuses are written back by the owning workstations only.
              </p>
            </div>
          )}
        </SectionCard>
      </div>
    </RouteGuard>
  );
}
