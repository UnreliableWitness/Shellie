import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_LABEL,
  LIFECYCLE_ORDER,
  RECENT_MS,
  lifecycleOf,
  taskSignal,
  type PrPulse,
} from "./pulse";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function pulse(over: Partial<PrPulse> = {}): PrPulse {
  return {
    workspaceId: "a",
    pr: {
      id: 1,
      url: "u",
      status: "active",
      isDraft: false,
      createdAt: iso(NOW - 3 * H),
      closedAt: null,
    },
    ci: "passing",
    ciFailedName: null,
    review: "waiting",
    approvals: { have: 0, need: null },
    conflict: false,
    unanswered: 0,
    checkedAt: iso(NOW),
    ...over,
  };
}
const withPr = (
  over: Partial<NonNullable<PrPulse["pr"]>>,
  rest: Partial<PrPulse> = {},
): PrPulse => pulse({ pr: { ...pulse().pr!, ...over }, ...rest });
const idle = NOW - 5 * H;
const run = (
  pulses: PrPulse[],
  extra: { lastActiveAt?: number | null; agentBlocked?: boolean } = {},
) =>
  lifecycleOf({
    pulses,
    lastActiveAt: idle,
    agentBlocked: false,
    now: NOW,
    ...extra,
  });

describe("lifecycleOf", () => {
  it("merged wins", () => {
    const r = lifecycleOf({
      pulses: [
        withPr(
          { status: "completed", closedAt: iso(NOW - 2 * H) },
          { ci: "failing" },
        ),
      ],
      lastActiveAt: NOW,
      agentBlocked: true,
      now: NOW,
    });
    expect(r.group).toBe("merged");
    expect(r.chip?.kind).toBe("finish");
    expect(r.sortKey).toBe(NOW - 2 * H);
  });

  it("recent wins over trouble", () => {
    const r = run([pulse({ ci: "failing" })], { lastActiveAt: NOW - 3 * H });
    expect(r.group).toBe("active");
    expect(r.chip?.kind).toBe("ci-failing");
    expect(r.chip?.tone).toBe("red");
    expect(r.sortKey).toBe(-(NOW - 3 * H));
  });

  it("recent boundary", () => {
    const r = run([pulse({ ci: "failing" })], {
      lastActiveAt: NOW - RECENT_MS,
    });
    expect(r.group).not.toBe("active");
  });

  it("trouble when idle", () => {
    const a = run([pulse({ ci: "failing", ciFailedName: "PR build" })]);
    expect(a.group).toBe("needs-you");
    expect(a.chip?.kind).toBe("ci-failing");
    expect(run([pulse({ conflict: true })]).chip?.kind).toBe("conflict");
    const c = run([pulse({ review: "changes-asked" })]);
    expect(c.chip?.kind).toBe("changes-asked");
    expect(c.chip?.tone).toBe("amber");
    const d = run([pulse({ unanswered: 2 })]);
    expect(d.chip?.kind).toBe("comments");
    expect(d.chip?.text).toBe("2 comments");
    const e = run([pulse()], { agentBlocked: true });
    expect(e.group).toBe("needs-you");
    expect(e.chip).toBeNull();
  });

  it("severity order", () => {
    expect(run([pulse({ ci: "failing", unanswered: 1 })]).chip?.kind).toBe(
      "ci-failing",
    );
    const keys = [
      run([pulse({ ci: "failing" })]).sortKey,
      run([pulse({ conflict: true })]).sortKey,
      run([pulse({ review: "changes-asked" })]).sortKey,
      run([pulse({ unanswered: 1 })]).sortKey,
      run([pulse()], { agentBlocked: true }).sortKey,
    ];
    expect([...keys].sort((x, y) => x - y)).toEqual(keys);
    expect(new Set(keys).size).toBe(5);
    const older = run([
      withPr({ createdAt: iso(NOW - 50 * H) }, { conflict: true }),
    ]).sortKey;
    const newer = run([
      withPr({ createdAt: iso(NOW - 10 * H) }, { conflict: true }),
    ]).sortKey;
    expect(older).toBeLessThan(newer);
  });

  it("published PR idle", () => {
    const w = run([pulse()]);
    expect(w.group).toBe("in-review");
    expect(w.chip).toMatchObject({ kind: "waiting", text: "3h" });
    expect(w.sortKey).toBe(NOW - 3 * H);
    const day = run([withPr({ createdAt: iso(NOW - 30 * H) })]);
    expect(day.chip?.text).toBe("1d");
    expect(run([pulse({ review: "approved" })]).chip).toMatchObject({
      kind: "approved",
      tone: "green",
    });
  });

  it("parked", () => {
    const p = run([]);
    expect(p.group).toBe("parked");
    expect(p.chip).toBeNull();
    const d = run([withPr({ isDraft: true })]);
    expect(d.group).toBe("parked");
    expect(d.chip).toMatchObject({ kind: "draft", tone: "muted" });
  });

  it("abandoned = no PR", () => {
    expect(run([withPr({ status: "abandoned" })]).group).toBe("parked");
  });

  it("two workspaces", () => {
    const done = withPr({ status: "completed", closedAt: iso(NOW - H) });
    expect(run([done, pulse({ workspaceId: "b" })]).group).toBe("in-review");
    expect(run([done, pulse({ workspaceId: "b", pr: null })]).group).toBe(
      "merged",
    );
    expect(
      run([done, withPr({ status: "abandoned" }, { workspaceId: "b" })]).group,
    ).toBe("merged");
    const r = run([
      pulse({ workspaceId: "a" }),
      pulse({ workspaceId: "b", ci: "failing" }),
    ]);
    expect(r.group).toBe("needs-you");
    expect(r.chip?.workspaceId).toBe("b");
  });

  it("sorts Active and Parked by recency", () => {
    expect(run([], { lastActiveAt: NOW - H }).sortKey).toBe(-(NOW - H));
    expect(run([], { lastActiveAt: NOW - H }).group).toBe("active");
    expect(run([], { lastActiveAt: null }).group).toBe("parked");
    expect(run([], { lastActiveAt: NOW - 9 * H }).sortKey).toBe(-(NOW - 9 * H));
  });

  it("story", () => {
    const r = run([
      withPr(
        { createdAt: iso(NOW - 30 * H) },
        {
          ci: "failing",
          ciFailedName: "PR build",
          approvals: { have: 1, need: 2 },
          unanswered: 2,
        },
      ),
    ]);
    expect(r.story).toBe(
      "CI failing: PR build · 1 of 2 approvals · 2 unanswered comments · waiting 1d",
    );
  });
});

describe("lifecycleOf fixes", () => {
  const done = withPr({ status: "completed", closedAt: iso(NOW - 2 * H) });
  const none = pulse({ workspaceId: "n", pr: null });
  const abandoned = (id: string) =>
    withPr({ status: "abandoned" }, { workspaceId: id });

  it("is merged when the PRs that exist are all completed", () => {
    expect(run([done, none]).group).toBe("merged");
    expect(run([done, abandoned("x")]).group).toBe("merged");
  });
  it("is not merged while another PR is active, or with only abandoned PRs", () => {
    expect(run([done, pulse({ workspaceId: "z" })]).group).not.toBe("merged");
    expect(run([abandoned("x")]).group).not.toBe("merged");
  });
  it("survives a missing createdAt without NaN", () => {
    const bad = withPr({ createdAt: "" });
    const r = run([bad]);
    expect(Number.isNaN(r.sortKey)).toBe(false);
    expect(r.chip?.text).not.toMatch(/NaN/);
    expect(r.story).not.toMatch(/NaN/);
    const t = run([withPr({ createdAt: "" }, { ci: "failing" })], {
      lastActiveAt: null,
    });
    expect(Number.isNaN(t.sortKey)).toBe(false);
  });
});

describe("lifecycle labels", () => {
  it("has the group order and labels", () => {
    expect(LIFECYCLE_ORDER).toEqual([
      "needs-you",
      "active",
      "in-review",
      "merged",
      "parked",
    ]);
    expect(LIFECYCLE_ORDER.map((g) => LIFECYCLE_LABEL[g])).toEqual([
      "Needs you",
      "Active",
      "In review",
      "Merged · close me",
      "Parked",
    ]);
  });
});

describe("taskSignal", () => {
  const sig = (pulses: PrPulse[], agentBlocked = false) =>
    taskSignal({ pulses, agentBlocked, now: NOW });
  const merged = (ws: string) =>
    withPr(
      { status: "completed", closedAt: iso(NOW - H) },
      { workspaceId: ws },
    );

  it("is merged when every live PR is completed", () => {
    expect(sig([merged("a")])).toEqual({
      state: "merged",
      story: "PR merged",
      prWorkspaceId: null,
    });
  });
  it("is merged beside an abandoned PR or a workspace without one", () => {
    expect(
      sig([
        merged("a"),
        withPr({ status: "abandoned" }, { workspaceId: "b" }),
        pulse({ workspaceId: "c", pr: null }),
      ]).state,
    ).toBe("merged");
  });
  it("is not merged while another PR is active", () => {
    expect(sig([merged("a"), pulse({ workspaceId: "b" })]).state).toBe("none");
  });
  it.each([
    [{ ci: "failing" as const }],
    [{ conflict: true }],
    [{ review: "changes-asked" as const }],
    [{ unanswered: 2 }],
  ])("waits on PR trouble %j and names its workspace", (over) => {
    const s = sig([pulse({ workspaceId: "w", ...over })]);
    expect(s.state).toBe("waits");
    expect(s.prWorkspaceId).toBe("w");
    expect(s.story).not.toBe("");
  });
  it("names the worse of two troubled workspaces", () => {
    const s = sig([
      pulse({ workspaceId: "a", unanswered: 1 }),
      pulse({ workspaceId: "b", ci: "failing", ciFailedName: "build" }),
    ]);
    expect(s.prWorkspaceId).toBe("b");
    expect(s.story).toContain("CI failing: build");
  });
  it("names the older PR when two have the same trouble", () => {
    const s = sig([
      withPr(
        { createdAt: iso(NOW - 2 * H) },
        { workspaceId: "a", conflict: true },
      ),
      withPr(
        { createdAt: iso(NOW - 9 * H) },
        { workspaceId: "b", conflict: true },
      ),
    ]);
    expect(s.prWorkspaceId).toBe("b");
  });
  it("waits on a blocked agent, with no PR to open", () => {
    const s = sig([pulse()], true);
    expect(s.state).toBe("waits");
    expect(s.prWorkspaceId).toBeNull();
    expect(s.story).toContain("agent needs you");
  });
  it("waits on a blocked agent without any pulse", () => {
    expect(sig([], true)).toEqual({
      state: "waits",
      story: "agent needs you",
      prWorkspaceId: null,
    });
  });
  it("is none for a healthy published PR, and still tells its story", () => {
    const s = sig([
      withPr(
        { createdAt: iso(NOW - 48 * H) },
        { approvals: { have: 1, need: 2 } },
      ),
    ]);
    expect(s).toEqual({
      state: "none",
      story: "1 of 2 approvals · waiting 2d",
      prWorkspaceId: null,
    });
  });
  it("is none and silent without pulses", () => {
    expect(sig([])).toEqual({ state: "none", story: "", prWorkspaceId: null });
  });
  it("is none for a draft PR", () => {
    expect(sig([withPr({ isDraft: true })]).state).toBe("none");
  });
});
