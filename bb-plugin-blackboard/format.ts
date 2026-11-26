import type { NodeView } from "./rpc.js";

export function minutes(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export function ago(at: number): string {
  return Date.now() - at < 60_000 ? "Just now" : `${minutes(Date.now() - at)} ago`;
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A fact's source as a label, such as "Tool output". */
export const source = (f: NodeView) => cap(String(f.data.source).replace(/_/g, " "));
