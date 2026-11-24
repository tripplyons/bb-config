// Graph page state shared by the page body and its title-bar control.
// Forces persist in localStorage, so the layout settings survive reloads.
import { useSyncExternalStore } from "react";

import { DEFAULT_GRAPH_FORCES, type GraphForceId, type GraphForces } from "./graph-logic";

interface GraphState {
  forces: GraphForces;
  settingsOpen: boolean;
}

const STORAGE_KEY = "bb-plugin-thread-graph:forces:v1";

function loadForces(): GraphForces {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved === null || typeof saved !== "object") return DEFAULT_GRAPH_FORCES;
    const forces: Record<string, number> = { ...DEFAULT_GRAPH_FORCES };
    // A force added later keeps its default until the user moves it.
    for (const key of Object.keys(DEFAULT_GRAPH_FORCES))
      if (typeof saved[key] === "number" && Number.isFinite(saved[key])) forces[key] = saved[key];
    return forces as GraphForces;
  } catch {
    return DEFAULT_GRAPH_FORCES;
  }
}

let state: GraphState = { forces: loadForces(), settingsOpen: false };
const listeners = new Set<() => void>();

function set(next: Partial<GraphState>) {
  state = { ...state, ...next };
  if (next.forces) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.forces));
    } catch {
      // Private mode or a full quota: the forces still apply for this session.
    }
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useGraphState<T>(select: (state: GraphState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export const graphActions = {
  setForce: (id: GraphForceId, value: number) => set({ forces: { ...state.forces, [id]: value } }),
  resetForces: () => set({ forces: DEFAULT_GRAPH_FORCES }),
  toggleSettings: () => set({ settingsOpen: !state.settingsOpen }),
  closeSettings: () => set({ settingsOpen: false }),
};
