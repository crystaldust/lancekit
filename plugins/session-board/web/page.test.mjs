// Tests for the pure helpers in index.html's <script id="board-logic">.
// Run: node --test plugins/session-board/web/page.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const source = /<script id="board-logic">([\s\S]*?)<\/script>/.exec(html)?.[1];
assert.ok(source, "index.html has a <script id=\"board-logic\"> block");
const context = vm.createContext({});
vm.runInContext(source, context);
const L = context.BoardLogic;

const NOW = Date.parse("2026-11-04T08:00:00.000Z");
const ago = ms => new Date(NOW - ms).toISOString();

function session(overrides = {}) {
  return {
    sessionId: "s", host: "mac-mini", cwd: "/Users/lance/app", project: "app",
    state: "working", isLost: false, waitingSince: ago(0), receivedAt: ago(0),
    detail: null, lastPrompt: null, lastAnswer: null, ecc: null, ...overrides,
  };
}

test("split keeps waiting sessions in server order and sends lost waiting ones to others", () => {
  const list = [
    session({ sessionId: "a", state: "needs-approval" }),
    session({ sessionId: "b", state: "your-turn" }),
    session({ sessionId: "c", state: "working" }),
    session({ sessionId: "d", state: "needs-approval", isLost: true }),
    session({ sessionId: "e", state: "ended" }),
  ];
  const { waiting, others } = L.split(list);
  assert.deepEqual(waiting.map(s => s.sessionId), ["a", "b"]);
  assert.deepEqual(others.map(s => s.sessionId), ["c", "d", "e"]);
});

test("kindOf: ended wins over lost, lost wins over the reported state", () => {
  assert.equal(L.kindOf(session({ state: "ended", isLost: false })), "ended");
  assert.equal(L.kindOf(session({ state: "your-turn", isLost: true })), "lost");
  assert.equal(L.kindOf(session({ state: "needs-approval" })), "approval");
  assert.equal(L.kindOf(session({ state: "your-turn" })), "turn");
  assert.equal(L.kindOf(session({ state: "working" })), "working");
});

test("counts every kind, including zeros, and hostCount counts distinct hosts", () => {
  const list = [
    session({ state: "needs-approval" }), session({ state: "needs-approval", host: "macbook" }),
    session({ state: "working" }), session({ state: "working", isLost: true }),
  ];
  assert.deepEqual({ ...L.counts(list) }, { approval: 2, turn: 0, working: 1, lost: 1, ended: 0 });
  assert.equal(L.hostCount(list), 2);
  assert.equal(L.hostCount([]), 0);
});

test("formatTimer switches to hours at one hour and clamps negatives", () => {
  assert.equal(L.formatTimer(0), "00:00");
  assert.equal(L.formatTimer(401_000), "06:41");
  assert.equal(L.formatTimer(3_599_999), "59:59");
  assert.equal(L.formatTimer(3_600_000), "1:00:00");
  assert.equal(L.formatTimer(37_230_000), "10:20:30");
  assert.equal(L.formatTimer(-5_000), "00:00");
});

test("formatAgo picks seconds, minutes or hours", () => {
  assert.equal(L.formatAgo(59_999), "59 秒");
  assert.equal(L.formatAgo(60_000), "1 分钟");
  assert.equal(L.formatAgo(3_600_000), "1 小时");
  assert.equal(L.formatAgo(-1), "0 秒");
});

test("durationText: timer for waiting and working, silence for lost, age for ended", () => {
  assert.equal(L.durationText(session({ state: "needs-approval", waitingSince: ago(401_000) }), NOW), "06:41");
  assert.equal(L.durationText(session({ state: "working", waitingSince: ago(492_000) }), NOW), "08:12");
  assert.equal(L.durationText(session({ isLost: true, waitingSince: ago(9_000_000), receivedAt: ago(125_000) }), NOW), "2 分钟");
  assert.equal(L.durationText(session({ state: "ended", waitingSince: ago(420_000) }), NOW), "7 分钟前");
});

test("eccText joins PRD and plan progress and prefers the plan for the bar", () => {
  const full = L.eccText({
    prd: { title: "x", done: 3, total: 8, inProgress: ["4"] },
    plan: { name: "y", done: 7, total: 14, isArchived: false },
    phase: "VALIDATE", isActive: true,
  });
  assert.equal(full.text, "PRD M3/8 ▶4 · T7/14");
  assert.equal(full.phase, "VALIDATE");
  assert.equal(full.fraction, 0.5);

  const prdOnly = L.eccText({ prd: { title: "x", done: 1, total: 4, inProgress: [] }, plan: null, phase: null, isActive: false });
  assert.equal(prdOnly.text, "PRD M1/4");
  assert.equal(prdOnly.phase, null);
  assert.equal(prdOnly.fraction, 0.25);

  const several = L.eccText({ prd: { title: "x", done: 1, total: 4, inProgress: ["2", "3"] }, plan: null, phase: "EXECUTE", isActive: false });
  assert.equal(several.text, "PRD M1/4 ▶2,3");
  assert.equal(several.phase, null, "phase only shows while /prp-implement runs");

  const planOnly = L.eccText({ prd: null, plan: { name: "y", done: 0, total: 0, isArchived: false }, phase: null, isActive: false });
  assert.equal(planOnly.text, "T0/0");
  assert.equal(planOnly.fraction, 0);

  const emptyPlan = L.eccText({ prd: { title: "x", done: 1, total: 4, inProgress: [] }, plan: { name: "y", done: 0, total: 0, isArchived: false }, phase: null, isActive: false });
  assert.equal(emptyPlan.fraction, 0.25, "a plan without tasks falls back to PRD progress");
});

test("isSnapshot rejects responses the page cannot render", () => {
  assert.equal(L.isSnapshot({ v: 1, now: "2026-11-04T08:00:00.000Z", sessions: [] }), true);
  assert.equal(L.isSnapshot({ v: 1, now: "2026-11-04T08:00:00.000Z", sessions: {} }), false);
  assert.equal(L.isSnapshot({ v: 1, sessions: [] }), false);
  assert.equal(L.isSnapshot({ v: 1, now: "soon", sessions: [] }), false);
  assert.equal(L.isSnapshot(null), false);
});

test("kindOf treats an unknown state as working", () => {
  assert.equal(L.kindOf(session({ state: "thinking" })), "working");
});

test("eccText is null without progress", () => {
  assert.equal(L.eccText(null), null);
  assert.equal(L.eccText(undefined), null);
  assert.equal(L.eccText({ prd: null, plan: null, phase: null, isActive: false }), null);
});

test("messageOf shows the last non-blank answer lines for your-turn", () => {
  const tail = ["", "1", "2", "3", "  ", "4", "5", "6"];
  const message = L.messageOf(session({ state: "your-turn", lastAnswer: { tail, at: ago(0) } }));
  assert.equal(message.label, "最后回答");
  assert.equal(message.kind, "tail");
  assert.deepEqual([...message.lines], ["3", "4", "5", "6"]);
});

test("messageOf falls back to the last instruction", () => {
  const prompt = { text: "跑测试", at: ago(0) };
  const turn = L.messageOf(session({ state: "your-turn", lastPrompt: prompt, lastAnswer: { tail: ["", " "], at: ago(0) } }));
  assert.equal(turn.label, "最后交代");
  assert.deepEqual([...turn.lines], ["跑测试"]);
  const approval = L.messageOf(session({ state: "needs-approval", lastPrompt: prompt, lastAnswer: { tail: ["ok"], at: ago(0) } }));
  assert.equal(approval.label, "最后交代", "an approval card shows what was asked, not the previous answer");
  assert.equal(L.messageOf(session({ state: "your-turn" })), null);
});

test("shortPath abbreviates home folders only", () => {
  assert.equal(L.shortPath("/Users/lance/Development/git/lancekit"), "~/Development/git/lancekit");
  assert.equal(L.shortPath("/home/dev"), "~");
  assert.equal(L.shortPath("/srv/app"), "/srv/app");
  assert.equal(L.shortPath("/Users"), "/Users");
});

test("errorReason names the cause", () => {
  assert.equal(L.errorReason(new Error("HTTP 401")), "HTTP 401：令牌不对");
  assert.equal(L.errorReason(new Error("HTTP 502")), "HTTP 502：服务出错");
  assert.equal(L.errorReason(new Error("HTTP 404")), "HTTP 404");
  assert.equal(L.errorReason(new TypeError("Failed to fetch")), "网络不通");
  assert.equal(L.errorReason(undefined), "网络不通");
  assert.equal(L.errorReason(Object.assign(new Error("signal timed out"), { name: "TimeoutError" })), "超时没有回应");
  assert.equal(L.errorReason(new Error("bad response")), "响应格式不对");
});

test("syncText, clockText and timeText format for the header and banner", () => {
  assert.equal(L.syncText(2, 2_400), "2 台机器 · 2 秒前更新");
  assert.equal(L.syncText(1, -50), "1 台机器 · 0 秒前更新");
  const date = new Date(2026, 10, 4, 9, 5, 7);
  assert.equal(L.clockText(date), "09:05");
  assert.equal(L.timeText(date), "09:05:07");
});
