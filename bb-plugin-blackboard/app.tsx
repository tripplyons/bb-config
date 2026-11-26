// Blackboard's side-panel tab: the board of the run that the open thread
// belongs to, for planner, worker, and reviewer threads. It is read-only;
// the user steers a run by talking to its planner thread. Board writes on
// the server invalidate the `board` read, so the tab stays live.
//
// The layout uses bb's own Info tab components (InfoSection, DetailRow,
// InfoList, InfoListRow) so the tab looks like the host's panels.

import {
  definePluginApp,
  experimental_DetailRow as DetailRow,
  experimental_Icon as Icon,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
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

function minutes(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

function ago(at: number): string {
  return Date.now() - at < 60_000 ? "Just now" : `${minutes(Date.now() - at)} ago`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A fact's source as a label, such as "Tool output". */
const source = (f: NodeView) => cap(String(f.data.source).replace(/_/g, " "));

// ---------------------------------------------------------------- status dots

type DotStyle = { className: string; label: string };

/** An 8px status mark. Filled means settled or active; hollow means not started or set aside. */
const DOT: Record<string, DotStyle> = {
  running: { className: "bg-primary animate-pulse", label: "Running" },
  queued: { className: "border border-muted-foreground/60", label: "Queued" },
  waiting: { className: "border-2 border-primary", label: "Waiting for an answer" },
  unmerged: { className: "border-2 border-destructive", label: "Not merged" },
  done: { className: "bg-muted-foreground/70", label: "Done" },
  blocked: { className: "bg-destructive", label: "Blocked" },
  exhausted: { className: "bg-destructive", label: "Exhausted" },
  failed: { className: "bg-destructive", label: "Failed" },
  stopped: { className: "border border-muted-foreground/40", label: "Stopped" },
  skipped: { className: "border border-muted-foreground/40", label: "Skipped" },
  complete: { className: "bg-primary", label: "Complete" },
  revise: { className: "border-2 border-destructive", label: "Revise" },
  canceled: { className: "bg-muted-foreground/50", label: "Canceled" },
  open: { className: "border-2 border-primary", label: "Open" },
  answered: { className: "bg-muted-foreground/70", label: "Answered" },
  pass: { className: "bg-primary", label: "Pass" },
  fail: { className: "bg-destructive", label: "Fail" },
  unknown: { className: "border border-muted-foreground/60", label: "Unknown" },
};

function Dot({ status }: { status: string }) {
  const style = DOT[status] ?? DOT.queued!;
  return (
    <span className="flex size-3 shrink-0 items-center justify-center" title={style.label} aria-label={style.label} role="img">
      <span className={`size-2 rounded-full ${style.className}`} />
    </span>
  );
}

// ---------------------------------------------------------------- building blocks

function Muted({ children, tone, mono }: { children: ReactNode; tone?: "bad"; mono?: boolean }) {
  return (
    <p className={`text-xs leading-snug break-words whitespace-pre-wrap ${tone === "bad" ? "text-destructive" : "text-muted-foreground"} ${mono ? "font-mono text-[11px]" : ""}`}>
      {children}
    </p>
  );
}

/** A wrapping list row: a 12px mark, text that may run to several lines, and detail lines under it. */
function Row({
  mark,
  title,
  trailing,
  details,
  onSelect,
  highlight,
  tooltip,
}: {
  mark: ReactNode;
  title: ReactNode;
  trailing?: ReactNode;
  details?: ReactNode;
  onSelect?: () => void;
  highlight?: boolean;
  tooltip?: string;
}) {
  const body = (
    <>
      <div className="flex items-start gap-2">
        <span className="mt-[3px]">{mark}</span>
        <span className="min-w-0 flex-1 text-[13px] leading-snug text-foreground">{title}</span>
        {trailing && <span className="shrink-0 text-xs leading-5 text-muted-foreground">{trailing}</span>}
      </div>
      {details && <div className="mt-0.5 space-y-0.5 pl-5">{details}</div>}
    </>
  );
  const className = `block w-full rounded-md px-1.5 py-1 text-left ${highlight ? "bg-accent" : ""}`;
  return (
    <li title={tooltip}>
      {onSelect ? (
        <button type="button" className={`${className} hover:bg-accent/60`} onClick={onSelect}>
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1.5 text-xs text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------- header

function Header({ view, threadId }: { view: BoardView; threadId: string }) {
  const { run } = view;
  const navigate = useBbNavigate();
  const goals = view.nodes.filter((n) => n.kind === "goal");
  const met = goals.filter((g) => g.status === "met").length;
  const percent = goals.length ? Math.round((met / goals.length) * 100) : 0;
  const role =
    view.role === "planner"
      ? "Talk to this thread to steer the run."
      : view.role === "worker"
        ? "This thread works on the highlighted intent."
        : "This thread reviews the highlighted cycle.";
  return (
    <header className="space-y-2 px-1.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Dot status={run.status} />
        <span className="text-foreground">{cap(run.status)}</span>
        <span>· cycle {run.cycle}</span>
        <span>· {run.id}</span>
        <span className="ml-auto">{ago(run.createdAt)}</span>
      </div>
      <h2 className="text-sm leading-snug font-semibold text-foreground">{run.title}</h2>
      <div className="space-y-1">
        <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={met} aria-valuemax={goals.length} aria-label="Goals met">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">
          {goals.length ? `${met} of ${goals.length} goals met` : "No goals yet"}
        </p>
      </div>
      {run.summary && <Muted>{run.summary}</Muted>}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">{role}</span>
        {run.plannerThreadId && run.plannerThreadId !== threadId && (
          <button type="button" className="shrink-0 text-foreground underline-offset-2 hover:underline" onClick={() => navigate.toThread(run.plannerThreadId!)}>
            Open planner
          </button>
        )}
      </div>
    </header>
  );
}

type Target = BoardView["run"]["settings"]["reviewer"];

/** A model choice as a label, such as "glm-5.3-flash (acp-opencode)". */
function target(t: Target | null): string {
  if (!t || (!t.model && !t.provider)) return "Planner's provider default";
  const model = t.model ? t.model.split("/").at(-1)! : "Default model";
  const level = t.reasoningLevel ? `, ${t.reasoningLevel}` : "";
  return t.provider ? `${model} (${t.provider}${level})` : `${model}${level}`;
}

function RunDetails({ view }: { view: BoardView }) {
  const { run } = view;
  const s = run.settings;
  const used = view.nodes.filter((n) => n.kind === "intent").length;
  const workspace =
    s.workspace === "worktree"
      ? `Worktrees from ${run.baselineCommit?.slice(0, 7) ?? "the baseline"}`
      : s.workspace === "shared"
        ? "Shared checkout"
        : "Set up at first dispatch";
  const checks = s.checks === "review" ? "no check intents" : s.checks === "once" ? "one check intent per cycle" : "thorough checks";
  return (
    <InfoSection label="Run">
      <dl className="space-y-1 px-1.5 text-xs">
        <DetailRow label="Intents">
          {used} of {s.maxIntents} used, {s.parallel} at once
        </DetailRow>
        <DetailRow label="Review">{s.review ? `Required, ${checks}` : `Not required, ${checks}`}</DetailRow>
        <DetailRow label="Workspace">{workspace}</DetailRow>
        <DetailRow label="Workers" align="start">
          {s.workers.length ? [...new Set(s.workers.map(target))].join(", ") : target(null)}
        </DetailRow>
        <DetailRow label="Reviewer">{target(s.reviewer)}</DetailRow>
        {s.smokeCheck && (
          <DetailRow label="Smoke check">
            <code className="font-mono text-[11px]">{s.smokeCheck}</code>
          </DetailRow>
        )}
        {run.deadlineAt !== null && (
          <DetailRow label="Deadline">
            {run.deadlineAt > Date.now() ? `In ${minutes(run.deadlineAt - Date.now())}` : `Passed ${minutes(Date.now() - run.deadlineAt)} ago`}
          </DetailRow>
        )}
      </dl>
    </InfoSection>
  );
}

// ---------------------------------------------------------------- sections

function Goals({ goals }: { goals: NodeView[] }) {
  return (
    <InfoSection label="Goals" count={goals.length}>
      {goals.length === 0 ? (
        <Empty>The planner records goals first.</Empty>
      ) : (
        <ol className="space-y-0.5">
          {goals.map((goal) => {
            const proof = goal.data.proof as { reason?: unknown } | null | undefined;
            const reopened = goal.data.reopened as { reason?: unknown } | null | undefined;
            const met = goal.status === "met";
            return (
              <Row
                key={goal.id}
                tooltip={`Goal #${goal.id}`}
                mark={
                  met ? (
                    <span className="flex size-3 items-center justify-center rounded-full bg-primary" title="Met" role="img" aria-label="Met">
                      <Icon name="Check" className="size-2.5 text-primary-foreground" />
                    </span>
                  ) : (
                    <Dot status="open" />
                  )
                }
                title={<span className={met ? "text-muted-foreground" : undefined}>{goal.summary}</span>}
                details={
                  <>
                    {met && str(proof?.reason) && <Muted>{str(proof?.reason)}</Muted>}
                    {!met && str(reopened?.reason) && <Muted tone="bad">Reopened: {str(reopened?.reason)}</Muted>}
                  </>
                }
              />
            );
          })}
        </ol>
      )}
    </InfoSection>
  );
}

const INTENT_ORDER = ["running", "waiting", "unmerged", "queued", "blocked", "exhausted", "done", "stopped", "skipped"];

function IntentDetails({ intent }: { intent: NodeView }) {
  const d = intent.data;
  const smoke = d.smoke as { status?: unknown; exitCode?: unknown; tail?: unknown } | undefined;
  const deps = numbers(d.dependsOn);
  const paths = strings(d.files).length ? strings(d.files) : strings(d.writes);
  const live = ["running", "waiting", "queued"].includes(intent.status);
  return (
    <>
      {paths.length > 0 && (
        <Muted mono>
          {paths.slice(0, 4).join("  ")}
          {paths.length > 4 ? `  +${paths.length - 4}` : ""}
        </Muted>
      )}
      {intent.status === "queued" && deps.length > 0 && <Muted>Starts after {deps.map((x) => `#${x}`).join(", ")}</Muted>}
      {!live && str(d.report) && <Muted>{str(d.report)!.slice(0, 220)}</Muted>}
      {str(d.integrationError) && <Muted tone="bad">{cap(str(d.integrationError)!)}</Muted>}
      {str(d.error) && <Muted tone="bad">{cap(str(d.error)!)}</Muted>}
      {smoke?.status === "failed" && (
        <Muted tone="bad">
          Smoke check failed with exit {String(smoke.exitCode)}
          {str(smoke.tail) ? `: ${str(smoke.tail)!.trim().split("\n").at(-1)}` : ""}
        </Muted>
      )}
    </>
  );
}

function Intents({ intents, highlight }: { intents: NodeView[]; highlight: number | null }) {
  const navigate = useBbNavigate();
  const sorted = [...intents].sort((a, b) => INTENT_ORDER.indexOf(a.status) - INTENT_ORDER.indexOf(b.status) || b.id - a.id);
  const live = intents.filter((i) => ["running", "waiting", "queued"].includes(i.status)).length;
  return (
    <InfoSection label="Intents" count={intents.length} accessory={live ? <span className="text-xs text-muted-foreground">{live} live</span> : undefined}>
      {sorted.length === 0 ? (
        <Empty>No intents yet.</Empty>
      ) : (
        <ul className="space-y-0.5">
          <InfoList
            items={sorted}
            limit={8}
            getKey={(i) => String(i.id)}
            renderItem={(intent) => (
              <Row
                key={intent.id}
                tooltip={`Intent #${intent.id}${intent.threadId ? ", click to open its thread" : ""}`}
                highlight={intent.id === highlight}
                mark={<Dot status={intent.status} />}
                title={
                  <>
                    {intent.summary}
                    {intent.data.check === true && <span className="ml-1.5 text-xs text-muted-foreground">Check</span>}
                  </>
                }
                trailing={DOT[intent.status]?.label ?? intent.status}
                details={<IntentDetails intent={intent} />}
                onSelect={intent.threadId ? () => navigate.toThread(intent.threadId!) : undefined}
              />
            )}
          />
        </ul>
      )}
    </InfoSection>
  );
}

interface Check {
  verdict?: unknown;
  evidence?: unknown;
  commands?: Array<{ command?: unknown; exitCode?: unknown }>;
}

function Reviews({ reviews, goals, highlight }: { reviews: NodeView[]; goals: NodeView[]; highlight: number | null }) {
  const navigate = useBbNavigate();
  if (!reviews.length) return null;
  const newest = [...reviews].reverse();
  return (
    <InfoSection label="Reviews" count={reviews.length}>
      <ul className="space-y-0.5">
        {newest.map((review, index) => {
          const checks = (Array.isArray(review.data.checks) ? review.data.checks : []) as Check[];
          const checkIn = numbers(review.data.checkIn);
          const expanded = index === 0 || review.id === highlight;
          return (
            <Row
              key={review.id}
              tooltip={`Review #${review.id}`}
              highlight={review.id === highlight}
              mark={<Dot status={review.status} />}
              title={`Cycle ${num(review.data.cycle) ?? "?"}`}
              trailing={DOT[review.status]?.label ?? review.status}
              onSelect={review.threadId ? () => navigate.toThread(review.threadId!) : undefined}
              details={
                <>
                  {str(review.data.feedback) && <Muted>{str(review.data.feedback)}</Muted>}
                  {str(review.data.error) && <Muted tone="bad">{cap(str(review.data.error)!)}</Muted>}
                  {checkIn.length > 0 && <Muted tone="bad">Failed twice in a row: {checkIn.map((g) => `#${g}`).join(", ")}. The planner will ask you.</Muted>}
                  {expanded &&
                    checks.map((check, i) => (
                      <div key={i} className="flex items-start gap-1.5 pt-0.5">
                        <span className="mt-[3px]">
                          <Dot status={typeof check.verdict === "string" ? check.verdict : "unknown"} />
                        </span>
                        <div className="min-w-0 space-y-0.5">
                          <p className="text-xs text-foreground">{goals[i]?.summary ?? `Goal ${i + 1}`}</p>
                          {str(check.evidence) && <Muted>{str(check.evidence)}</Muted>}
                          {(check.commands ?? []).map((c, j) => (
                            <Muted key={j} mono>
                              $ {String(c.command)} → {String(c.exitCode)}
                            </Muted>
                          ))}
                        </div>
                      </div>
                    ))}
                </>
              }
            />
          );
        })}
      </ul>
    </InfoSection>
  );
}

function Questions({ questions }: { questions: NodeView[] }) {
  if (!questions.length) return null;
  const open = questions.filter((q) => q.status === "open").length;
  return (
    <InfoSection label="Questions" count={questions.length} accessory={open ? <span className="text-xs text-destructive">{open} open</span> : undefined}>
      <ul className="space-y-0.5">
        {[...questions].reverse().map((q) => (
          <Row
            key={q.id}
            tooltip={`Question #${q.id} from ${q.origin.replace(/^intent/, "Intent")}`}
            mark={<Dot status={q.status} />}
            title={q.summary}
            details={
              q.status === "open" ? <Muted>Answer it in the planner thread.</Muted> : str(q.data.answer) ? <Muted>Answer: {str(q.data.answer)}</Muted> : null
            }
          />
        ))}
      </ul>
    </InfoSection>
  );
}

function CompactList({ label, items, context, trailing }: { label: string; items: NodeView[]; context?: (n: NodeView) => string | undefined; trailing?: (n: NodeView) => ReactNode }) {
  if (!items.length) return null;
  return (
    <InfoSection label={label} count={items.length}>
      <InfoList
        items={items}
        limit={5}
        getKey={(n) => String(n.id)}
        renderItem={(n) => (
          <InfoListRow
            leading={<span className="size-1 rounded-full bg-muted-foreground/60" />}
            name={n.summary}
            title={`#${n.id}: ${n.summary}`}
            context={context?.(n)}
            trailing={trailing?.(n)}
          />
        )}
      />
    </InfoSection>
  );
}

// ---------------------------------------------------------------- tab

export function BoardTab({ threadId }: { threadId: string }) {
  const { data, error, isLoading } = useBoard(threadId);
  if (isLoading) return <div className="p-4 text-xs text-muted-foreground">Loading the board…</div>;
  if (error && !data) return <div className="p-4 text-xs text-destructive">Could not load the board: {error.message}</div>;
  if (!data) return <div className="p-4 text-xs text-muted-foreground">This thread is not part of a Blackboard run.</div>;
  const of = (kind: NodeView["kind"]) => data.nodes.filter((n) => n.kind === kind);
  const newestFirst = (kind: NodeView["kind"]) => of(kind).reverse();
  const goals = of("goal");
  const facts = data.facts;
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-2 py-3">
      <Header view={data} threadId={threadId} />
      <Questions questions={of("question")} />
      <Goals goals={goals} />
      <Intents intents={of("intent")} highlight={data.nodeId} />
      <Reviews reviews={of("review")} goals={goals} highlight={data.nodeId} />
      <CompactList label="Guidance" items={newestFirst("hint")} context={(n) => cap(n.origin)} />
      <CompactList label="Planner fixes" items={newestFirst("fix")} context={(n) => strings(n.data.files).join(", ")} />
      <CompactList
        label="Constraints"
        items={of("constraint").filter((c) => c.status !== "removed")}
        trailing={(n) => <span className={`text-xs ${n.data.type === "deny" ? "text-destructive" : "text-muted-foreground"}`}>{cap(String(n.data.type))}</span>}
      />
      {data.run.todo.length > 0 && (
        <InfoSection label="Planner todo" count={data.run.todo.length}>
          <ul className="space-y-0.5">
            {data.run.todo.map((item, i) => (
              <Row
                key={i}
                mark={<Dot status={item.status === "completed" ? "done" : item.status === "in_progress" ? "running" : "queued"} />}
                title={<span className={item.status === "completed" ? "text-muted-foreground line-through" : undefined}>{item.text}</span>}
              />
            ))}
          </ul>
        </InfoSection>
      )}
      {facts.length > 0 && (
        <InfoSection label="Recent facts" count={data.factCount}>
          <InfoList
            items={facts}
            limit={5}
            getKey={(f) => String(f.id)}
            renderItem={(f) => (
              <InfoListRow
                leading={<span className={`size-1.5 rounded-full ${f.data.confidence === "observed" ? "bg-primary" : "border border-muted-foreground"}`} />}
                leadingLabel={cap(String(f.data.confidence))}
                name={f.summary}
                title={`#${f.id}: ${f.summary} (${cap(String(f.data.confidence))}, ${source(f)})`}
                context={num(f.data.intentId) !== null ? `Intent #${num(f.data.intentId)}` : source(f)}
              />
            )}
          />
        </InfoSection>
      )}
      <RunDetails view={data} />
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
