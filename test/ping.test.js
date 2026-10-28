// Tests for `hypatia ping` (lib/ping.js): what it posts to Discord for review
// requests and questions, who it @mentions, and when it stays quiet. Nothing
// is ever posted: the tests check the payloads. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const ping = require("../lib/ping");
const { makeRepo, write, commit, BEN } = require("./helpers");

const DISCORD_ID = "123456789012345678";
const GRAPH = {
  repo: "acme/notes-app",
  branch: "main",
  people: [
    { id: "ana", name: "Ana", github: "ana-gh", color: "#ff4d5e" },
    { id: "ben", name: "Ben", github: "bencarter", color: "#b5e61d", discord_id: DISCORD_ID },
  ],
  nodes: [
    { id: "search", title: "Search", path: "docs/wiki/search.md", last_change: { person: "ana" } },
    { id: "sync", title: "Sync", path: "docs/wiki/sync.md", last_change: { person: "ana" } },
  ],
  work: [{ kind: "pr", number: 12, person: "ben", assignees: [], pages: ["search"] }],
};

const issue = (labels, extra = {}) => ({
  number: 7,
  title: "How does search rank results?",
  html_url: "https://github.com/acme/notes-app/issues/7",
  user: { login: "newbie" },
  labels: labels.map((name) => ({ name })),
  created_at: "2026-10-20T09:00:00Z",
  updated_at: "2026-10-20T10:00:00Z",
  ...extra,
});

const FILLED = `<!-- Answer each part in a line or two. -->

## Who
<!-- Your name -->
Ana, review: Ben

## What
Rank exact names first.

## Why
People search for a note by its name most of the time.

## Before
Exact names could show up on page two.

## After
An exact name is always the first result.

## How to test
Search for a note's full name.

## Wiki
Updated search.
`;

const PARTLY = `## Who
<!-- Your name -->

## What
Faster sync.

## Why
<!-- Why does the project need it? -->

**Before:** sync froze on big notebooks.
After: it finishes in under a second.
`;

const LAYERED = `<!-- written by an agent -->
Search now ranks exact names first, so the note you meant is on top.

- Before: exact names could land on page two. After: they come first.
- Before: no way to see why a note ranked. After: hovering shows the score.

<details><summary>How it works</summary>

**The pieces** - ranker - scores notes
</details>

wiki: no change needed - docs only
`;

function prEvent(action = "opened", { body = FILLED, reviewers = ["bencarter"], ...extra } = {}) {
  return {
    action,
    pull_request: {
      number: 12,
      title: "Exact names first",
      html_url: "https://github.com/acme/notes-app/pull/12",
      user: { login: "ana-gh" },
      labels: [],
      body,
      draft: false,
      requested_reviewers: reviewers.map((login) => ({ login })),
      created_at: "2026-10-20T09:00:00Z",
      updated_at: "2026-10-20T10:00:00Z",
      ...extra,
    },
  };
}

const fields = (payload) => Object.fromEntries(payload.embeds[0].fields.map((f) => [f.name, f.value]));
const questionText = (event) => {
  const [kind, payload] = ping.buildMessage("issues", event, GRAPH);
  assert.strictEqual(kind, "question");
  return payload.content;
};

test("description: a filled template, a partly filled one, an empty one", () => {
  const sec = ping.parseDescription(FILLED);
  assert.strictEqual(sec.who, "Ana, review: Ben");
  assert.strictEqual(sec.what, "Rank exact names first.");
  assert.strictEqual(sec.why, "People search for a note by its name most of the time.");
  assert.strictEqual(sec.before, "Exact names could show up on page two.");
  assert.strictEqual(sec.after, "An exact name is always the first result.");
  assert.strictEqual(sec["how to test"], "Search for a note's full name.");
  assert.strictEqual(sec.wiki, "Updated search.");

  const part = ping.parseDescription(PARTLY);
  assert.ok(!("who" in part) && !("why" in part), "a prompt comment alone is empty");
  assert.strictEqual(part.what, "Faster sync.");
  assert.strictEqual(part.before, "sync froze on big notebooks.");
  assert.strictEqual(part.after, "it finishes in under a second.");

  assert.deepStrictEqual(ping.parseDescription("## Who\n<!-- x -->\n"), {});
  assert.deepStrictEqual(ping.parseDescription(""), {});
  assert.deepStrictEqual(ping.parseDescription(null), {});
  assert.strictEqual(ping.parseDescription("## What\nWhat a change.\nWhy not.\n").what, "What a change.\nWhy not.");
});

test("description: an opening paragraph and Before/After bullets", () => {
  const sec = ping.parseDescription(LAYERED);
  assert.strictEqual(sec._first, "Search now ranks exact names first, so the note you meant is on top.");
  assert.strictEqual(sec.before, "- exact names could land on page two.\n- no way to see why a note ranked.");
  assert.strictEqual(sec.after, "- they come first.\n- hovering shows the score.");
  assert.strictEqual(sec.wiki, "no change needed - docs only");
  assert.ok(!("why" in sec));
});

test("question: @mentions whoever works on the page by discord_id, else names the last changer", () => {
  const text = questionText({ action: "opened", issue: issue(["question", "wiki:search"], { user: { login: "ana-gh" } }) });
  assert.match(text, /^\*\*Question\*\* from Ana on \[Search\]\(<https:\/\/github\.com\/acme\/notes-app\/blob\/main\/docs\/wiki\/search\.md>\): How does search rank results\?/);
  assert.match(text, /<https:\/\/github\.com\/acme\/notes-app\/issues\/7>/);
  assert.match(text, new RegExp(`Can you help\\? <@${DISCORD_ID}>$`), "Ben has open work on search");

  const other = questionText({ action: "opened", issue: issue(["question", "wiki:sync"]) });
  assert.match(other, /from newbie/);
  assert.match(other, /Can you help\? Ana$/, "no discord_id: named");
  const local = ping.buildMessage("issues", { action: "opened", issue: issue(["question", "wiki:sync"]) }, { ...GRAPH, repo: null })[1].content;
  assert.match(local, /on Sync: /, "no GitHub repo: the page by name, no broken link");
});

test("question: the label echo of 'opened', other labels and plain issues stay quiet", () => {
  const echo = issue(["question", "wiki:search"], { updated_at: "2026-10-20T09:00:05Z" });
  assert.strictEqual(ping.buildMessage("issues", { action: "labeled", label: { name: "question" }, issue: echo }, GRAPH), null);
  assert.strictEqual(ping.buildMessage("issues", { action: "labeled", label: { name: "wiki:search" }, issue: issue(["question", "wiki:search"]) }, GRAPH), null);
  assert.match(questionText({ action: "labeled", label: { name: "question" }, issue: issue(["question", "wiki:search"]) }), /\*\*Question\*\*/);
  assert.strictEqual(ping.buildMessage("issues", { action: "opened", issue: issue(["wiki:search"]) }, GRAPH), null);
});

test("review: Who, What, Why, Before, After, pages and the link, in the author's color", () => {
  const [kind, payload] = ping.buildMessage("pull_request_target", prEvent(), GRAPH);
  assert.strictEqual(kind, "review");
  assert.strictEqual(payload.content, "**Review requested by Ana** - any teammate can review: <https://github.com/acme/notes-app/pull/12>");
  const f = fields(payload);
  assert.strictEqual(f.Who, "Ana (@ana-gh)\nAna, review: Ben");
  assert.strictEqual(f.What, "**Exact names first**\nRank exact names first.");
  assert.strictEqual(f.Why, "People search for a note by its name most of the time.");
  assert.strictEqual(f.Before, "Exact names could show up on page two.");
  assert.strictEqual(f.After, "An exact name is always the first result.");
  assert.strictEqual(f["Wiki pages"], "[Search](https://github.com/acme/notes-app/blob/main/docs/wiki/search.md)");
  assert.strictEqual(f["Review it"], "https://github.com/acme/notes-app/pull/12");
  assert.strictEqual(payload.embeds[0].color, 0xff4d5e);
  assert.ok(!("footer" in payload.embeds[0]));
  assert.match(ping.asText(payload), /Why: People search/);
});

test("review: an unfilled description falls back to its first paragraph, or says so", () => {
  let [, payload] = ping.buildMessage("pull_request_target", prEvent("opened", { body: LAYERED, number: 99 }), GRAPH);
  let f = fields(payload);
  assert.strictEqual(f.Why, "Search now ranks exact names first, so the note you meant is on top.");
  assert.strictEqual(f["Wiki pages"], "no change needed - docs only");
  assert.match(payload.embeds[0].footer.text, /first paragraph/);
  [, payload] = ping.buildMessage("pull_request_target", prEvent("opened", { body: "## Who\n<!-- x -->\n", number: 99 }), GRAPH);
  f = fields(payload);
  assert.deepStrictEqual([f.Why, f.Before, f.After, f["Wiki pages"]], ["not filled in", "not filled in", "not filled in", "none listed"]);
  // an author not on the team: named by login, no color, nobody @mentioned
  [, payload] = ping.buildMessage("pull_request_target", prEvent("opened", { reviewers: [], user: { login: "newbie" } }), GRAPH);
  assert.match(payload.content, /^\*\*Review requested by @newbie\*\*/);
  assert.doesNotMatch(payload.content, /<@/);
  assert.ok(!("color" in payload.embeds[0]));
});

test("review: one post per review request", () => {
  const post = (ev) => ping.buildMessage("pull_request_target", ev, GRAPH);
  assert.strictEqual(post(prEvent("opened", { draft: true })), null, "drafts wait for ready_for_review");
  assert.ok(post(prEvent("ready_for_review")));
  const echo = prEvent("review_requested", { updated_at: "2026-10-20T09:00:03Z" });
  echo.requested_reviewer = { login: "bencarter" };
  assert.strictEqual(post(echo), null, "the review_requested right after opened");
  const both = ["ana-gh", "bencarter"];
  const first = prEvent("review_requested", { reviewers: both });
  first.requested_reviewer = { login: "ana-gh" };
  const last = prEvent("review_requested", { reviewers: both });
  last.requested_reviewer = { login: "bencarter" };
  assert.strictEqual(post(first), null);
  assert.match(post(last)[1].content, /Review requested by Ana/);
  assert.strictEqual(ping.buildMessage("pull_request", { action: "synchronize", pull_request: {} }, GRAPH), null);
});

test("webhooks: routing and fallbacks", () => {
  const env = { DISCORD_REVIEW_WEBHOOK_URL: "r", DISCORD_QUESTIONS_WEBHOOK_URL: "q", DISCORD_WEBHOOK_URL: "o" };
  assert.deepStrictEqual(ping.webhookFor("review", env), ["DISCORD_REVIEW_WEBHOOK_URL", "r"]);
  assert.deepStrictEqual(ping.webhookFor("question", env), ["DISCORD_QUESTIONS_WEBHOOK_URL", "q"]);
  assert.deepStrictEqual(ping.webhookFor("question", { DISCORD_REVIEW_WEBHOOK_URL: "r" }), ["DISCORD_REVIEW_WEBHOOK_URL", "r"]);
  assert.deepStrictEqual(ping.webhookFor("question", { DISCORD_WEBHOOK_URL: "o", DISCORD_QUESTIONS_WEBHOOK_URL: " " }), ["DISCORD_WEBHOOK_URL", "o"]);
  assert.deepStrictEqual(ping.webhookFor("review", { DISCORD_QUESTIONS_WEBHOOK_URL: "q" }), [null, ""]);
});

test("hypatia ping: no webhook passes quietly; --dry-run builds the real post from the repo, discord ids included", async () => {
  const repo = makeRepo({ generic: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-ping-"));
  try {
    const lines = [];
    const io = { log: (s) => lines.push(s), error: (s) => lines.push(s) };
    assert.strictEqual(await ping.pingCommand(repo.root, [], { ...io, env: { GITHUB_EVENT_NAME: "issues" } }), 0);
    assert.match(lines.join("\n"), /Discord not set up yet/);

    write(repo.root, "docs/hypatia.yml", `people:\n  - github: bencarter\n    name: Ben Carter\n    discord_id: "${DISCORD_ID}"\n`);
    commit(repo.root, BEN, "Config: Ben's chat id");
    const event = path.join(dir, "event.json");
    fs.writeFileSync(event, JSON.stringify({ action: "opened", issue: issue(["question", "wiki:keyboard-teleop"]) }));
    lines.length = 0;
    const code = await ping.pingCommand(repo.root, ["--dry-run", "--event", event], { ...io, env: { GITHUB_EVENT_NAME: "issues" } });
    assert.strictEqual(code, 0, lines.join("\n"));
    // Ben changed the keyboard teleop page last, so he is asked, by his id
    assert.match(lines.join("\n"), new RegExp(`Would post to Discord:[\\s\\S]*Can you help\\? <@${DISCORD_ID}>`));
  } finally {
    repo.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
