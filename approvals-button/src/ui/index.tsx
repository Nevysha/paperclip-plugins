import { useEffect, type CSSProperties } from "react";
import { useHostLocation, useHostNavigation, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

const REFRESH_MS = 30 * 1000;

const button: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid var(--border)",
  color: "var(--foreground)",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  textDecoration: "none",
  whiteSpace: "nowrap",
};
const flag: CSSProperties = {
  minWidth: 18,
  height: 18,
  padding: "0 5px",
  boxSizing: "border-box",
  borderRadius: 9,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  background: "var(--destructive)",
  color: "white",
};

export function ApprovalsButton({ context }: PluginWidgetProps) {
  const nav = useHostNavigation();
  const { pathname } = useHostLocation();
  const { data, refresh } = usePluginData<{ count: number }>("pending", { companyId: context.companyId });

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Picks up an approval you just decided as soon as you navigate away.
  useEffect(() => refresh(), [pathname]);

  const count = data?.count ?? 0;
  return (
    <a {...nav.linkProps("/approvals/pending")}
      aria-label={count > 0 ? `Approvals, ${count} pending` : "Approvals"}
      style={button}>
      Approvals
      {count > 0 ? <span style={flag}>{count > 99 ? "99+" : count}</span> : null}
    </a>
  );
}
