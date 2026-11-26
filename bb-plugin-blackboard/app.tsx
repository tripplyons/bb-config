// Blackboard's side-panel tab: the board of the run that the open thread
// belongs to, for planner, worker, and reviewer threads. It is read-only;
// the user steers a run by talking to its planner thread. Board writes on
// the server invalidate the `board` read, so the tab stays live.

import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { rpcContract, type BoardView, type NodeView } from "./rpc";

export const TAB_ID = "board";

function useBoard(threadId: string) {
  return useRpcQuery({ contract: rpcContract, method: "board", input: { threadId } });
}

// ---------------------------------------------------------------- helpers

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);

function ago(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

type Tone = "neutral" | "active" | "good" | "warn" | "bad";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-border text-muted-foreground",
  active: "border-primary/40 bg-primary/10 text-primary",
  good: "border-primary/40 text-primary",
  warn: "border-border bg-muted text-foreground",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
};

const STATUS_TONE: Record<string, Tone> = {
  running: "active",
  queued: "neutral",
  waiting: "warn",
  unmerged: "warn",
  done: "good",
  met: "good",
  complete: "good",
  answered: "neutral",
  open: "neutral",
  revise: "warn",
  blocked: "bad",
  exhausted: "bad",
  failed: "bad",
  canceled: "bad",
  stopped: "neutral",
  skipped: "neutral",
};

function Badge({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[11px] leading-4 font-medium ${TONE_CLASS[tone ?? "neutral"]}`}>
      {children}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status}</Badge>;
}

function ThreadLink({ threadId, label }: { threadId: string; label: string }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      onClick={() => navigate.toThread(threadId)}
    >
      <Icon name="MessageSquare" className="size-3" />
      {label}
    </button>
  );
}

function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="space-y-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        {title}
        {count !== undefined && <span className="font-normal">({count})</span>}
      </button>
      {open && <div className="space-y-2">{children}</div>}
    </section>
  );
}

function Card({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return (
    <div className={`space-y-1 rounded-md border p-2 ${highlight ? "border-primary/60 bg-primary/5" : "border-border bg-card"}`}>{children}</div>
  );
}

function Paths({ paths, label }: { paths: string[]; label: string }) {
  if (!paths.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span>{label}:</span>
      {paths.slice(0, 8).map((p) => (
        <code key={p} className="rounded bg-muted px-1 font-mono text-[11px] text-foreground">
          {p}
        </code>
      ))}
      {paths.length > 8 && <span>+{paths.length - 8} more</span>}
    </div>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: "bad" }) {
  return <p className={`text-xs whitespace-pre-wrap ${tone === "bad" ? "text-destructive" : "text-muted-foreground"}`}>{children}</p>;
}

// ---------------------------------------------------------------- sections

function RunHeader({ view, threadId }: { view: BoardView; threadId: string }) {
  const { run } = view;
  const used = view.nodes.filter((n) => n.kind === "intent").length;
  const workspace =
    run.settings.workspace === "worktree"
      ? `worktrees at ${run.baselineCommit?.slice(0, 10) ?? "baseline"}`
      : run.settings.workspace === "shared"
        ? "shared checkout"
        : "workspace pending";
  const you =
    view.role === "planner"
      ? "This is the run's planner thread. Steer the run by talking to it."
      : view.role === "worker"
        ? `This thread works on intent #${view.nodeId}.`
        : `This thread is the reviewer for review #${view.nodeId}.`;
  return (
    <header className="space-y-1.5">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          {run.id}: {run.title}
        </h2>
        <StatusBadge status={run.status} />
      </div>
      <div className="flex flex-wrap gap-1">
        <Badge>cycle {run.cycle}</Badge>
        <Badge>
          {used}/{run.settings.maxIntents} intents
        </Badge>
        <Badge>{run.settings.parallel} at once</Badge>
        <Badge>checks: {run.settings.checks}</Badge>
        <Badge>{run.settings.review ? "review required" : "no review"}</Badge>
        <Badge>{workspace}</Badge>
        {run.deadlineAt !== null && <Badge tone={run.deadlineAt < Date.now() ? "bad" : "neutral"}>deadline {new Date(run.deadlineAt).toLocaleTimeString()}</Badge>}
      </div>
      <Note>
        {you} Started {ago(run.createdAt)}.
      </Note>
      {run.plannerThreadId && run.plannerThreadId !== threadId && <ThreadLink threadId={run.plannerThreadId} label="Open the planner thread" />}
      {run.summary && <Note>{run.summary}</Note>}
    </header>
  );
}

function Goals({ goals }: { goals: NodeView[] }) {
  const met = goals.filter((g) => g.status === "met").length;
  return (
    <Section title={`Goals, ${met} of ${goals.length} met`}>
      {goals.length === 0 && <Note>No goals yet. The planner proposes them first.</Note>}
      <ol className="space-y-1.5">
        {goals.map((goal, i) => {
          const proof = goal.data.proof as { reason?: unknown; evidence?: unknown } | null | undefined;
          const reopened = goal.data.reopened as { reason?: unknown } | null | undefined;
          return (
            <li key={goal.id} className="flex items-start gap-2">
              <Icon
                name={goal.status === "met" ? "CircleCheck" : "Circle"}
                className={`mt-0.5 size-4 shrink-0 ${goal.status === "met" ? "text-primary" : "text-muted-foreground"}`}
              />
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm text-foreground">
                  <span className="text-muted-foreground">
                    {i + 1}. #{goal.id}
                  </span>{" "}
                  {goal.summary}
                </p>
                {proof && str(proof.reason) && (
                  <Note>
                    Proved: {str(proof.reason)} (facts {numbers(proof.evidence).map((e) => `#${e}`).join(", ")})
                  </Note>
                )}
                {goal.status === "open" && reopened && str(reopened.reason) && <Note>Reopened: {str(reopened.reason)}</Note>}
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function IntentCard({ intent, highlight }: { intent: NodeView; highlight: boolean }) {
  const d = intent.data;
  const smoke = d.smoke as { status?: unknown; exitCode?: unknown; tail?: unknown } | undefined;
  const deps = numbers(d.dependsOn);
  const resolves = numbers(d.resolves);
  return (
    <Card highlight={highlight}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm text-foreground">
          <span className="text-muted-foreground">#{intent.id}</span> {intent.summary}
        </p>
        {d.check === true && <Badge>check</Badge>}
        <StatusBadge status={intent.status} />
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {num(d.cycle) !== null && <span>cycle {num(d.cycle)}</span>}
        {deps.length > 0 && <span>after {deps.map((x) => `#${x}`).join(", ")}</span>}
        {resolves.length > 0 && <span>resolves {resolves.map((x) => `#${x}`).join(", ")}</span>}
        {d.integrated === true && <span>integrated</span>}
      </div>
      <Paths label="writes" paths={strings(d.writes)} />
      <Paths label="changed" paths={strings(d.files)} />
      {str(d.report) && <Note>{str(d.report)}</Note>}
      {str(d.integrationError) && <Note tone="bad">{str(d.integrationError)}</Note>}
      {str(d.error) && <Note tone="bad">{str(d.error)}</Note>}
      {smoke?.status === "failed" && (
        <Note tone="bad">
          Smoke check failed (exit {String(smoke.exitCode)}): {str(smoke.tail)?.slice(-300)}
        </Note>
      )}
      {intent.threadId && <ThreadLink threadId={intent.threadId} label="Open thread" />}
    </Card>
  );
}

const INTENT_GROUPS: Array<{ title: string; statuses: string[]; open: boolean }> = [
  { title: "Live intents", statuses: ["running", "waiting", "queued"], open: true },
  { title: "Unmerged intents", statuses: ["unmerged"], open: true },
  { title: "Done intents", statuses: ["done"], open: false },
  { title: "Ended intents", statuses: ["blocked", "exhausted", "stopped", "skipped"], open: false },
];

function Intents({ intents, highlight }: { intents: NodeView[]; highlight: number | null }) {
  if (!intents.length) return <Note>No intents yet.</Note>;
  return (
    <>
      {INTENT_GROUPS.map((group) => {
        const items = intents.filter((i) => group.statuses.includes(i.status)).reverse();
        if (!items.length) return null;
        const open = group.open || items.some((i) => i.id === highlight) || items.length <= 3;
        return (
          <Section key={group.title} title={group.title} count={items.length} defaultOpen={open}>
            {items.map((intent) => (
              <IntentCard key={intent.id} intent={intent} highlight={intent.id === highlight} />
            ))}
          </Section>
        );
      })}
    </>
  );
}

interface Check {
  verdict?: unknown;
  kind?: unknown;
  evidence?: unknown;
  commands?: Array<{ command?: unknown; exitCode?: unknown }>;
}

function Reviews({ reviews, goals, highlight }: { reviews: NodeView[]; goals: NodeView[]; highlight: number | null }) {
  if (!reviews.length) return null;
  return (
    <Section title="Reviews" count={reviews.length}>
      {[...reviews].reverse().map((review, index) => {
        const checks = (Array.isArray(review.data.checks) ? review.data.checks : []) as Check[];
        const checkIn = numbers(review.data.checkIn);
        return (
          <Card key={review.id} highlight={review.id === highlight}>
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-sm text-foreground">
                <span className="text-muted-foreground">#{review.id}</span> Cycle {num(review.data.cycle) ?? "?"} review
              </p>
              <StatusBadge status={review.status} />
            </div>
            {str(review.data.feedback) && <Note>{str(review.data.feedback)}</Note>}
            {str(review.data.error) && <Note tone="bad">{str(review.data.error)}</Note>}
            {checkIn.length > 0 && <Note tone="bad">Failed twice in a row: {checkIn.map((g) => `#${g}`).join(", ")}. The planner asks you what to do.</Note>}
            {(index === 0 || review.id === highlight) && checks.length > 0 && (
              <ul className="space-y-1 pt-1">
                {checks.map((check, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs">
                    <Icon
                      name={check.verdict === "pass" ? "Check" : check.verdict === "fail" ? "X" : "CircleHelp"}
                      className={`mt-px size-3.5 shrink-0 ${check.verdict === "pass" ? "text-primary" : check.verdict === "fail" ? "text-destructive" : "text-muted-foreground"}`}
                    />
                    <div className="min-w-0">
                      <span className="text-foreground">Goal {goals[i] ? `#${goals[i]!.id}` : i + 1}:</span>{" "}
                      <span className="text-muted-foreground">{str(check.evidence)}</span>
                      {(check.commands ?? []).map((c, j) => (
                        <code key={j} className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                          $ {String(c.command)} (exit {String(c.exitCode)})
                        </code>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {review.threadId && <ThreadLink threadId={review.threadId} label="Open reviewer thread" />}
          </Card>
        );
      })}
    </Section>
  );
}

function Questions({ questions }: { questions: NodeView[] }) {
  if (!questions.length) return null;
  const open = questions.filter((q) => q.status === "open");
  return (
    <Section title={open.length ? `Questions, ${open.length} open` : "Questions"} count={questions.length} defaultOpen={open.length > 0}>
      {[...questions].reverse().map((q) => (
        <Card key={q.id}>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-sm whitespace-pre-wrap text-foreground">
              <span className="text-muted-foreground">#{q.id}</span> {q.summary}
            </p>
            <StatusBadge status={q.status} />
          </div>
          <Note>
            From {q.origin}
            {q.status === "open" ? ". Answer in the planner thread." : str(q.data.answer) ? `. Answer: ${str(q.data.answer)}` : ""}
          </Note>
        </Card>
      ))}
    </Section>
  );
}

function SimpleList({ title, items, render, defaultOpen }: { title: string; items: NodeView[]; render: (n: NodeView) => ReactNode; defaultOpen?: boolean }) {
  if (!items.length) return null;
  return (
    <Section title={title} count={items.length} defaultOpen={defaultOpen}>
      <ul className="space-y-1">
        {[...items].reverse().map((n) => (
          <li key={n.id} className="text-sm text-foreground">
            <span className="text-muted-foreground">#{n.id}</span> {render(n)}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Facts({ view }: { view: BoardView }) {
  if (!view.factCount) return null;
  return (
    <Section title="Recent facts" count={view.factCount} defaultOpen={false}>
      <ul className="space-y-1.5">
        {view.facts.map((f) => (
          <li key={f.id} className="space-y-0.5">
            <p className="text-sm text-foreground">
              <span className="text-muted-foreground">#{f.id}</span> {f.summary}
            </p>
            <div className="flex flex-wrap gap-1">
              <Badge>{String(f.data.confidence)}</Badge>
              <Badge>{String(f.data.source)}</Badge>
              {f.data.negative === true && <Badge>negative</Badge>}
              {num(f.data.intentId) !== null && <Badge>intent #{num(f.data.intentId)}</Badge>}
            </div>
          </li>
        ))}
      </ul>
      {view.factCount > view.facts.length && <Note>Showing the newest {view.facts.length}. `bb blackboard facts {view.run.id}` lists all.</Note>}
    </Section>
  );
}

// ---------------------------------------------------------------- tab

export function BoardTab({ threadId }: { threadId: string }) {
  const { data, error, isLoading } = useBoard(threadId);
  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading the board…</div>;
  if (error && !data) return <div className="p-4 text-sm text-destructive">Could not load the board: {error.message}</div>;
  if (!data) return <div className="p-4 text-sm text-muted-foreground">This thread is not part of a Blackboard run.</div>;
  const of = (kind: NodeView["kind"]) => data.nodes.filter((n) => n.kind === kind);
  const goals = of("goal");
  const highlight = data.nodeId;
  const cycle = data.run.cycle;
  return (
    <div className="h-full space-y-4 overflow-y-auto p-3">
      <RunHeader view={data} threadId={threadId} />
      <Goals goals={goals} />
      <Questions questions={of("question")} />
      <Intents intents={of("intent")} highlight={highlight} />
      <Reviews reviews={of("review")} goals={goals} highlight={highlight} />
      <SimpleList
        title="Guidance and hints"
        items={of("hint")}
        defaultOpen={false}
        render={(n) => (
          <>
            {n.summary} <span className="text-xs text-muted-foreground">({n.origin})</span>
          </>
        )}
      />
      <SimpleList
        title="Planner fixes"
        items={of("fix")}
        defaultOpen={of("fix").some((f) => num(f.data.cycle) === cycle)}
        render={(n) => (
          <>
            {n.summary} <span className="text-xs text-muted-foreground">({strings(n.data.files).join(", ")})</span>
          </>
        )}
      />
      <SimpleList
        title="Constraints"
        items={of("constraint").filter((c) => c.status !== "removed")}
        defaultOpen={false}
        render={(n) => (
          <>
            <Badge tone={n.data.type === "deny" ? "bad" : "good"}>{String(n.data.type)}</Badge> {n.summary}
          </>
        )}
      />
      {data.run.todo.length > 0 && (
        <Section title="Planner todo" count={data.run.todo.length} defaultOpen={false}>
          <ul className="space-y-0.5">
            {data.run.todo.map((item, i) => (
              <li key={i} className="flex items-start gap-1.5 text-sm text-foreground">
                <Icon
                  name={item.status === "completed" ? "SquareCheck" : item.status === "in_progress" ? "SquareDot" : "Square"}
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
                {item.text}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Facts view={data} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    id: TAB_ID,
    title: "Board",
    icon: "Network",
    tooltip: "Blackboard run",
    context: { kind: "thread" },
    availability: "fixed",
    layout: "flush",
    useVisible: ({ threadId }) => Boolean(useBoard(threadId).data),
    component: BoardTab,
  });
});
