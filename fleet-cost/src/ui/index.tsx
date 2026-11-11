import { useMemo, useState } from "react";
import {
  useHostLocation,
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { total } from "../pricing.js";
import { CSS, Seg, localToday, usd, useApi, useTtl } from "./common.js";
import { CostView, type Usage } from "./cost.js";
import { ToolsView, type ToolsData } from "./tools.js";
import { EfficiencyView, type EfficiencyData } from "./efficiency.js";

type Tab = "cost" | "tools" | "efficiency";
const TAB_KEY = "nevysha.fleet-cost.tab";

function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => {
    try { const v = localStorage.getItem(TAB_KEY); return v === "tools" || v === "efficiency" ? v : "cost"; } catch { return "cost"; }
  });
  return [tab, (t) => { setTab(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* per-viewer convenience only */ } }];
}

const INTRO: Record<Tab, string> = {
  cost: "What the fleet's Claude usage would cost at API prices. You pay a flat subscription, so this is an estimate of the value used, not a bill.",
  tools: "Where each run's tokens go. Every tool call makes the model re-read the whole context, so a call costs about the context it's made at, whatever it prints.",
  efficiency: "Tokens spent per line of merged code. A task's tokens include every run on it; its lines come from the merged commits its runs made.",
};

function Loading({ error }: { error: string | null }) {
  return error ? <p className="fc-err" role="alert">Couldn&apos;t load: {error}</p> : <p className="fc-muted">Loading…</p>;
}

export function FleetCostPage({ context }: PluginPageProps) {
  const { pathname } = useHostLocation();
  const [tab, setTab] = useTab();
  const [ttl, setTtl] = useTtl();
  const usage = useApi<Usage>("usage", tab === "cost" ? context.companyId : null, pathname);
  const tools = useApi<ToolsData>("tools", tab === "tools" ? context.companyId : null, pathname);
  const eff = useApi<EfficiencyData>("efficiency", tab === "efficiency" ? context.companyId : null, pathname);

  return (
    <main className="fc-root">
      <style>{CSS}</style>
      <div className="fc-head">
        <div>
          <h1>Token Lens</h1>
          <p className="fc-sub">{INTRO[tab]}</p>
        </div>
        <div className="fc-controls">
          <span className="fc-ctl-label">Price cache writes at</span>
          <Seg label="Cache write price" value={ttl} onChange={setTtl} options={[["1h", "1-hour rate"], ["5m", "5-minute rate"]]} />
        </div>
      </div>
      <nav className="fc-tabs" aria-label="Views">
        <Seg label="View" value={tab} onChange={setTab} options={[["cost", "Cost"], ["tools", "Tools"], ["efficiency", "Efficiency"]]} />
      </nav>

      {tab === "cost" ? (usage.data ? <CostView data={usage.data} ttl={ttl} /> : <Loading error={usage.error} />) : null}
      {tab === "tools" ? (tools.data ? <ToolsView data={tools.data} ttl={ttl} /> : <Loading error={tools.error} />) : null}
      {tab === "efficiency" ? (eff.data ? <EfficiencyView data={eff.data} ttl={ttl} /> : <Loading error={eff.error} />) : null}
    </main>
  );
}

// ---------------------------------------------------------------- header button and sidebar link

function useTodayCost(companyId: string | null): number | null {
  const { pathname } = useHostLocation();
  const { data } = useApi<Usage>("usage", companyId, pathname);
  const [ttl] = useTtl();
  return useMemo(() => {
    if (!data) return null;
    const today = localToday();
    return total(data.rows.filter((r) => r.day === today), ttl).cost.total;
  }, [data, ttl]);
}

export function FleetCostSidebarLink({ context }: PluginSidebarProps) {
  const nav = useHostNavigation();
  const today = useTodayCost(context.companyId);
  return (
    <a {...nav.linkProps("/fleet-cost")}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80"
      style={{ textDecoration: "none" }}>
      <span className="flex-1 truncate">Token Lens</span>
      {today != null ? <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{usd(today)}</span> : null}
    </a>
  );
}

export function FleetCostToolbarButton({ context }: PluginWidgetProps) {
  const nav = useHostNavigation();
  const today = useTodayCost(context.companyId);
  return (
    <a {...nav.linkProps("/fleet-cost")}
      aria-label={today != null ? `Token Lens, ${usd(today)} at API prices today` : "Token Lens"}
      title="Token Lens: what today's usage would cost at Claude API prices, and where the tokens go"
      style={{
        padding: "6px 12px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border)", color: "var(--foreground)",
        display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", whiteSpace: "nowrap",
      }}>
      Cost
      {today != null ? <strong style={{ fontVariantNumeric: "tabular-nums" }}>{usd(today)}</strong> : null}
    </a>
  );
}
