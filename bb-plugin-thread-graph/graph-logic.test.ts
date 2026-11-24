import assert from "node:assert/strict";
import test from "node:test";

import {
  buildThreadGraph,
  createGraphSimulation,
  DEFAULT_GRAPH_FORCES,
  graphStructureSignature,
  nextSimulationAlpha,
  retainGraphPositions,
  tickGraphSimulation,
  type GraphSimulation,
  type GraphThread,
} from "./graph-logic.ts";

function settle(sim: GraphSimulation): number {
  let ticks = 0;
  while (tickGraphSimulation(sim, DEFAULT_GRAPH_FORCES)) ticks += 1;
  return ticks;
}

function hasCardOverlap(sim: GraphSimulation): boolean {
  for (let i = 0; i < sim.nodes.length; i += 1) {
    const a = sim.nodes[i]!;
    for (let j = i + 1; j < sim.nodes.length; j += 1) {
      const b = sim.nodes[j]!;
      const overlapX = a.halfWidth + b.halfWidth - Math.abs(b.x - a.x);
      const overlapY = a.halfHeight + b.halfHeight - Math.abs(b.y - a.y);
      if (overlapX > 1e-3 && overlapY > 1e-3) return true;
    }
  }
  return false;
}

function transition(prevSim: GraphSimulation, nextThreads: readonly GraphThread[]): GraphSimulation {
  const nextGraph = buildThreadGraph(nextThreads);
  const retained = retainGraphPositions(prevSim.nodes, nextGraph);
  const nextSim = createGraphSimulation(nextGraph, retained.positions);
  nextSim.alpha = nextSimulationAlpha({
    first: false,
    settleNow: retained.carriedOver === 0 || retained.added + retained.removed > 8,
    structureChanged: true,
    forcesChanged: false,
    heatBefore: prevSim.alpha,
  });
  settle(nextSim);
  return nextSim;
}

test("graphStructureSignature ignores sidebar reorderings but detects set, kind, parent, and project changes", () => {
  const a = buildThreadGraph([
    { id: "t1", projectId: "p1", parentThreadId: null },
    { id: "t2", projectId: "p2", parentThreadId: null },
  ]);
  const reordered = buildThreadGraph([
    { id: "t2", projectId: "p2", parentThreadId: null },
    { id: "t1", projectId: "p1", parentThreadId: null },
  ]);
  assert.equal(graphStructureSignature(a), graphStructureSignature(reordered));

  const removed = buildThreadGraph([{ id: "t1", projectId: "p1", parentThreadId: null }]);
  assert.notEqual(graphStructureSignature(a), graphStructureSignature(removed));

  const reparented = buildThreadGraph([
    { id: "t1", projectId: "p1", parentThreadId: null },
    { id: "t2", projectId: "p1", parentThreadId: "t1" },
  ]);
  assert.notEqual(graphStructureSignature(a), graphStructureSignature(reparented));
});

test("removing nodes reheats and recenters the remaining graph without leaving stale gaps", () => {
  const six = buildThreadGraph([
    { id: "a1", projectId: "p1", parentThreadId: null },
    { id: "a2", projectId: "p1", parentThreadId: "a1" },
    { id: "a3", projectId: "p1", parentThreadId: "a1" },
    { id: "b1", projectId: "p2", parentThreadId: null },
    { id: "b2", projectId: "p2", parentThreadId: "b1" },
    { id: "c1", projectId: "p3", parentThreadId: null },
  ]);
  const sim6 = createGraphSimulation(six);
  settle(sim6);

  const sim2 = transition(sim6, [
    { id: "a1", projectId: "p1", parentThreadId: null },
    { id: "c1", projectId: "p3", parentThreadId: null },
  ]);
  assert.equal(hasCardOverlap(sim2), false);

  // Centroid of the two remaining roots should pull back near (0, 0) instead of staying stranded.
  const cx = (sim2.nodes[0]!.x + sim2.nodes[1]!.x) / 2;
  const cy = (sim2.nodes[0]!.y + sim2.nodes[1]!.y) / 2;
  assert.ok(Math.hypot(cx, cy) < 0.2, `expected recentered layout, got (${cx}, ${cy})`);

  // Down to a single remaining node: it should settle at the origin.
  const sim1 = transition(sim2, [{ id: "a1", projectId: "p1", parentThreadId: null }]);
  assert.ok(
    Math.hypot(sim1.nodes[0]!.x, sim1.nodes[0]!.y) < 0.05,
    `expected single node at origin, got (${sim1.nodes[0]!.x}, ${sim1.nodes[0]!.y})`,
  );
});

test("adding a root thread to an existing project spawns near that project's live centroid", () => {
  const initial = buildThreadGraph([
    { id: "p1_a", projectId: "p1", parentThreadId: null },
    { id: "p2_a", projectId: "p2", parentThreadId: null },
  ]);
  const sim = createGraphSimulation(initial);
  settle(sim);
  // Move p2's existing node far away to verify the new p2 root follows p2's live centroid,
  // even when the new root appears first in `graph` (as busy threads do in bb's sidebar).
  const p2Node = sim.nodes.find((n) => n.key === "p2_a")!;
  p2Node.x = 6;
  p2Node.y = -4;

  const nextGraph = buildThreadGraph([
    { id: "p2_b", projectId: "p2", parentThreadId: null },
    { id: "p1_a", projectId: "p1", parentThreadId: null },
    { id: "p2_a", projectId: "p2", parentThreadId: null },
  ]);
  const retained = retainGraphPositions(sim.nodes, nextGraph);
  const nextSim = createGraphSimulation(nextGraph, retained.positions);
  const spawned = nextSim.nodes.find((n) => n.key === "p2_b")!;
  const distToProject = Math.hypot(spawned.x - 6, spawned.y - -4);
  assert.ok(distToProject < 2, `expected p2_b near p2_a, distance was ${distToProject}`);
});

test("a brand-new project sorted first does not spawn on top of an existing project at the origin", () => {
  const initial = buildThreadGraph([{ id: "p1_a", projectId: "p1", parentThreadId: null }]);
  const sim = createGraphSimulation(initial);
  settle(sim);

  const nextGraph = buildThreadGraph([
    { id: "p2_a", projectId: "p2", parentThreadId: null },
    { id: "p1_a", projectId: "p1", parentThreadId: null },
  ]);
  const retained = retainGraphPositions(sim.nodes, nextGraph);
  const nextSim = createGraphSimulation(nextGraph, retained.positions);
  const p1 = nextSim.nodes.find((n) => n.key === "p1_a")!;
  const p2 = nextSim.nodes.find((n) => n.key === "p2_a")!;
  assert.ok(Math.hypot(p2.x - p1.x, p2.y - p1.y) > 2, "new project should start away from existing project");
});

test("returning and re-parented nodes drop stale positions and settle cleanly near their current parent", () => {
  const withChild = buildThreadGraph([
    { id: "parent", projectId: "p1", parentThreadId: null },
    { id: "child", projectId: "p1", parentThreadId: "parent" },
    { id: "other", projectId: "p2", parentThreadId: null },
  ]);
  const sim1 = createGraphSimulation(withChild);
  settle(sim1);

  // Child leaves the graph.
  const sim2 = transition(sim1, [
    { id: "parent", projectId: "p1", parentThreadId: null },
    { id: "other", projectId: "p2", parentThreadId: null },
  ]);
  assert.equal(sim2.nodes.length, 2);

  // Child returns later: retainGraphPositions must treat it as added, not reuse stale coordinates.
  const returningGraph = buildThreadGraph([
    { id: "parent", projectId: "p1", parentThreadId: null },
    { id: "child", projectId: "p1", parentThreadId: "parent" },
    { id: "other", projectId: "p2", parentThreadId: null },
  ]);
  const retained = retainGraphPositions(sim2.nodes, returningGraph);
  assert.equal(retained.added, 1);
  assert.equal(retained.positions.has("child"), false);

  const sim3 = transition(sim2, [
    { id: "parent", projectId: "p1", parentThreadId: null },
    { id: "child", projectId: "p1", parentThreadId: "parent" },
    { id: "other", projectId: "p2", parentThreadId: null },
  ]);
  assert.equal(hasCardOverlap(sim3), false);

  // Re-parenting child from `parent` to `other` drops its old position too.
  const reparentedGraph = buildThreadGraph([
    { id: "parent", projectId: "p1", parentThreadId: null },
    { id: "other", projectId: "p2", parentThreadId: null },
    { id: "child", projectId: "p2", parentThreadId: "other" },
  ]);
  const reparentedRetained = retainGraphPositions(sim3.nodes, reparentedGraph);
  assert.equal(reparentedRetained.added, 1);
  assert.equal(reparentedRetained.positions.has("child"), false);
});
