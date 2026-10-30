// Tests for the graph builder (lib/build-graph.js): `npm test`.
//
// Most test pure functions (no network, no git). The last ones build the
// fixture repo end to end and check the problems the builder must stop on.
// The team itself (git, GitHub, colors, config) is in team.test.js.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const bg = require("../lib/build-graph");
const { globToRegex, matches } = require("../lib/globs");
const { makeRepo, write } = require("./helpers");

const TEAM_YML = `\
# comment line
people:
  - id: max
    name: Max
    github: max-gh
    color: "#ff4d5e"   # red
    chat_id: ""        # unknown keys are ignored
    focus: Computer vision - YOLO
    past: [object-detection]

  - id: sam
    name: Sam
    github: SamRivera9
    color: "#b5e61d"
    focus: Auto mapper
`;
const PEOPLE = bg.parseConfig(TEAM_YML).people;
const ROOT = path.resolve("/repo");
const CTX = bg.context({ root: ROOT, repo: "x/y", baseRef: "refs/remotes/origin/master", warn: () => {} });
// files from before a folder move, at their place today (as gitRenames finds them)
CTX.moved = (f) => (/^(slam|voice)\//.test(f) ? "src/" + f : f);
const wiki = (slug) => path.join(ROOT, "docs", "wiki", slug + ".md");
const readme = path.join(ROOT, "README.md");
const pagesOf = (spec) => new Map(Object.entries(spec));

// The center page, 3 hubs, 7 pages under them, one page two levels down.
function tree() {
  const spec = { home: null, senses: "home", driving: "home", brains: "home", lidar: "senses", camera: "senses", tf: "senses",
    slam: "senses", gamepad: "driving", voice: "brains", "llm-agent": "brains", deep: "llm-agent" };
  const d = (pid) => (spec[pid] === null ? 0 : 1 + d(spec[pid]));
  return Object.keys(spec).sort().reverse() // deliberately unsorted input
    .map((pid) => ({ id: pid, parent: spec[pid], depth: d(pid) }));
}
const dist = (pos, a, b) => Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]);

test("layout: same input, same positions", () => {
  assert.deepStrictEqual(bg.layout(tree()), bg.layout(tree().reverse()));
});

test("layout: the center page in the center, hubs on a ring, no overlaps", () => {
  const pos = bg.layout(tree());
  assert.deepStrictEqual(pos.home, [0, 0]);
  for (const hub of ["senses", "driving", "brains"]) assert.ok(Math.abs(Math.hypot(...pos[hub]) - 320) <= 0.2, hub);
  const ids = Object.keys(pos).sort();
  ids.forEach((a, i) => ids.slice(i + 1).forEach((b) => assert.ok(dist(pos, a, b) >= 50, `${a} and ${b} overlap`)));
});

test("layout: pages sit closer to their hub than to other hubs", () => {
  const pos = bg.layout(tree());
  for (const [page, hub] of [["lidar", "senses"], ["gamepad", "driving"], ["voice", "brains"]]) {
    const others = ["senses", "driving", "brains"].filter((h) => h !== hub);
    assert.ok(others.every((o) => dist(pos, page, hub) < dist(pos, page, o)), page);
  }
});

test("round1 rounds halves to even", () => {
  assert.deepStrictEqual([0.25, 0.75, -0.25, 1.25, 2.75, 1.04, 1.06, -3.14159].map(bg.round1), [0.2, 0.8, -0.2, 1.2, 2.8, 1.0, 1.1, -3.1]);
});

const GLOB_PAGES = pagesOf({
  slam: { file: wiki("slam"), code: ["src/app_core/config/mapper_params_online_async.yaml"] },
  "auto-mapper": { file: wiki("auto-mapper"), code: ["src/auto_mapper/**"] },
  lidar: { file: wiki("lidar"), code: ["src/lidar_processor*/**"] },
  home: { file: readme, code: [] },
});

test("globs: code globs and page files", () => {
  const hit = bg.pagesForFiles(["src/auto_mapper/auto_mapper/explorer.py", "src/lidar_processor_cpp/src/main.cpp", "docs/wiki/slam.md"], GLOB_PAGES, CTX);
  assert.deepStrictEqual(hit, ["auto-mapper", "lidar", "slam"]);
});

test("globs: README maps to the center page, unrelated files to nothing", () => {
  assert.deepStrictEqual(bg.pagesForFiles(["README.md"], GLOB_PAGES, CTX), ["home"]);
  assert.deepStrictEqual(bg.pagesForFiles(["docker/Dockerfile", "src/app_core/x.py"], GLOB_PAGES, CTX), []);
});

test("globs: * does not cross folders, ** does, a plain folder covers what is inside", () => {
  assert.ok(matches("src/a/b.py", ["src/a/*.py"]));
  assert.ok(!matches("src/a/c/b.py", ["src/a/*.py"]));
  assert.ok(matches("src/a/c/b.py", ["src/a/**/b.py"]));
  assert.ok(matches("src/a/b.py", ["src/a/**/b.py"]));
  assert.ok(matches("src/foo/x.py", ["./src/foo/"]));
  assert.ok(!matches("src/foobar/x.py", ["src/foo"]));
  assert.ok(globToRegex("src/a?.py").test("src/ab.py"));
  assert.ok(!globToRegex("src/a.py").test("src/aXpy"), "dots are literal");
});

test("people: parse the team list", () => {
  assert.deepStrictEqual(PEOPLE.map((p) => p.id), ["max", "sam"]);
  assert.strictEqual(PEOPLE[0].color, "#ff4d5e");
  assert.strictEqual(PEOPLE[0].focus, "Computer vision - YOLO");
  assert.deepStrictEqual(Object.keys(PEOPLE[1]).sort(), ["color", "discord_id", "focus", "github", "id", "name", "past"]);
  assert.deepStrictEqual(PEOPLE[0].past, ["object-detection"]);
  assert.deepStrictEqual(PEOPLE[1].past, []);
});

test("people: contributions by commit count", () => {
  const pages = pagesOf({
    home: { file: readme, code: [] },
    slam: { file: wiki("slam"), code: ["src/slam/**"] },
    lidar: { file: wiki("lidar"), code: ["src/lidar/**"] },
    voice: { file: wiki("voice"), code: ["src/voice/**"] },
  });
  const c = (author, email, ...files) => ({ author, email, files });
  const sam = "4242+SamRivera9@users.noreply.github.com";
  const commits = [
    c("SamR23", sam, "src/lidar/a.py", "README.md"),
    c("SamRivera9", sam, "src/lidar/b.py"),
    c("SamRivera9", sam, "docs/wiki/slam.md"), // wiki edit: not code work
    c("SamRivera9", sam, "src/voice/README.md"), // docs next to the code: not code work either
    c("SamRivera9", sam, "slam/old_layout.py"), // from before the folder moved: still counts
    c("Max Hawksby", "max@example.com", "docs/wiki/voice.md", "src/voice/x.py"),
    c("Stranger", "s@example.com", "src/slam/x.py"),
  ];
  const got = bg.contributions(commits, pages, PEOPLE, CTX);
  assert.deepStrictEqual(got.get("sam"), ["lidar", "slam"]); // 2 commits, then 1; the center page left out
  assert.deepStrictEqual(got.get("max"), ["voice"]); // one commit, counted once
  assert.deepStrictEqual(bg.contributions(commits, pages, PEOPLE, CTX, 1).get("sam"), ["lidar"]);
  const bulk = [c("SamRivera9", sam, ...Array.from({ length: bg.BULK_COMMIT_FILES + 1 }, (_, i) => `src/voice/${i}.py`))];
  assert.deepStrictEqual(bg.contributions(bulk, pages, PEOPLE, CTX).get("sam"), []); // a repo-wide move says nothing
});

test("people: match by login, email and name", () => {
  const m = (opts) => bg.matchPerson(PEOPLE, opts);
  assert.strictEqual(m({ login: "samrivera9" }), "sam");
  assert.strictEqual(m({ name: "SamR23", email: "4242+SamRivera9@users.noreply.github.com" }), "sam");
  assert.strictEqual(m({ name: "Max Hawksby", email: "someone@example.com" }), "max");
  assert.strictEqual(m({ name: "max-gh" }), "max");
  assert.strictEqual(m({ name: "Stranger", email: "x@example.com" }), null);
  assert.strictEqual(m({ login: "dependabot[bot]" }), null);
});

const QPAGES = pagesOf({ slam: {}, voice: {} });
const issue = (labels, user = "newbie", extra = {}) => ({
  number: 7, title: "How does SLAM localize?", html_url: "https://github.com/x/y/issues/7", user: { login: user },
  labels: labels.map((name) => ({ name })), comments: 0, updated_at: "2026-10-20T10:00:00Z", created_at: "2026-10-20T09:00:00Z", ...extra,
});

test("questions: unanswered when only the asker or bots commented", () => {
  const q = bg.questionFromIssue(issue(["question", "wiki:slam"]), [
    { user: { login: "newbie" }, body: "bump" },
    { user: { login: "github-actions[bot]" }, body: "noted" },
  ], QPAGES);
  assert.strictEqual(q.page, "slam");
  assert.strictEqual(q.answered, false);
  assert.strictEqual(q.answer_excerpt, "");
});

test("questions: answered by someone else, or by the label", () => {
  const q = bg.questionFromIssue(issue(["question", "wiki:slam"]), [{ user: { login: "SamRivera9" }, body: "It turns 360 degrees\nfirst." }], QPAGES);
  assert.strictEqual(q.answered, true);
  assert.strictEqual(q.answer_excerpt, "It turns 360 degrees first.");
  assert.strictEqual(bg.questionFromIssue(issue(["question", "wiki:slam", "answered"]), [], QPAGES).answered, true);
});

test("questions: not a question, or not on a page", () => {
  assert.strictEqual(bg.questionFromIssue(issue(["wiki:slam"]), [], QPAGES), null);
  assert.strictEqual(bg.questionFromIssue(issue(["question"]), [], QPAGES), null);
  assert.strictEqual(bg.questionFromIssue(issue(["question", "wiki:nope"]), [], QPAGES), null);
});

test("work: questions are not work, wiki issues are", () => {
  assert.strictEqual(bg.workFromIssue(issue(["question", "wiki:slam"]), QPAGES, PEOPLE), null);
  const w = bg.workFromIssue(issue(["wiki:slam"], "SamRivera9", { assignees: [{ login: "max-gh" }] }), QPAGES, PEOPLE);
  assert.deepStrictEqual([w.kind, w.person, w.assignees, w.pages], ["issue", "sam", ["max"], ["slam"]]);
});

test("work: a pull request wants review with reviewers or the review label", () => {
  const pages = pagesOf({ slam: { file: wiki("slam"), code: ["src/slam/**"] } });
  const pr = { number: 3, user: { login: "max-gh" }, labels: [], requested_reviewers: [], draft: true, updated_at: "", title: "t", html_url: "u" };
  const w = bg.workFromPr(pr, ["src/slam/a.py"], pages, PEOPLE, CTX);
  assert.deepStrictEqual([w.pages, w.review_requested, w.draft, w.person], [["slam"], false, true, "max"]);
  pr.requested_reviewers = [{ login: "SamRivera9" }];
  assert.strictEqual(bg.workFromPr(pr, [], pages, PEOPLE, CTX).review_requested, true);
  pr.requested_reviewers = [];
  pr.labels = [{ name: "review" }];
  assert.strictEqual(bg.workFromPr(pr, [], pages, PEOPLE, CTX).review_requested, true);
});

test("work: a pull request's head branch counts only from this repo", () => {
  const pages = pagesOf({ slam: { file: wiki("slam"), code: ["src/slam/**"] } });
  const pr = { number: 3, user: { login: "max-gh" }, labels: [], title: "t", html_url: "u",
    head: { ref: "feat/x", repo: { full_name: "acme/app" } } };
  assert.strictEqual(bg.workFromPr(pr, [], pages, PEOPLE, CTX, "acme/app").branch, "feat/x");
  pr.head.repo = { full_name: "someone/app" };
  assert.strictEqual(bg.workFromPr(pr, [], pages, PEOPLE, CTX, "acme/app").branch, null);
});

const BPAGES = pagesOf({
  home: { file: readme, code: [] },
  slam: { file: wiki("slam"), code: ["src/slam/**"] },
  voice: { file: wiki("voice"), code: ["src/voice/**"] },
  lidar: { file: wiki("lidar"), code: ["src/lidar/**"] },
});
const NOW = Date.parse("2026-10-22T12:00:00Z");
const SAM = "4242+SamRivera9@users.noreply.github.com";
const ref = (name, date, author = "SamR23", email = SAM, message = "Lidar: smooth scans") => ({ name, sha: "abc1234def", date, author, email, message });
const branches = (refs, info, work = []) => bg.activeBranches(refs, BPAGES, PEOPLE, work, NOW, info, CTX);

test("branches: 14 day cutoff, newest first", () => {
  const refs = [ref("fresh", "2026-10-22T10:00:00Z"), ref("edge", "2026-10-08T12:00:00+00:00"), // exactly 14 days: kept
    ref("stale", "2026-10-08T11:59:00Z"), // a minute older: dropped
    ref("other-zone", "2026-10-21T20:00:00-04:00")];
  assert.deepStrictEqual(branches(refs, () => [1, []]).map((b) => b.name), ["fresh", "other-zone", "edge"]);
});

test("branches: merged branches are left out", () => {
  assert.deepStrictEqual(branches([ref("merged", "2026-10-22T10:00:00Z")], () => [0, ["src/slam/a.py"]]), []);
});

test("branches: files to pages, person and pull request", () => {
  const files = {
    "sam/lidar": ["src/lidar/scan.py", "docs/wiki/slam.md", "notes.txt"],
    "max/old-layout": ["voice/tts.py", "README.md"], // from before the folder moved: lands on today's page
  };
  const refs = [ref("sam/lidar", "2026-10-22T09:00:00Z"), ref("max/old-layout", "2026-10-20T09:00:00Z", "Max Hawksby", "max@example.com")];
  const work = [{ kind: "pr", number: 12, url: "https://github.com/x/y/pull/12", branch: "sam/lidar" }, { kind: "issue", number: 13, url: "u", branch: null }];
  const got = Object.fromEntries(branches(refs, (name) => [files[name].length, files[name]], work).map((b) => [b.name, b]));
  const sam = got["sam/lidar"];
  const max = got["max/old-layout"];
  assert.deepStrictEqual([sam.person, sam.ahead, sam.pages], ["sam", 3, ["lidar", "slam"]]);
  assert.deepStrictEqual(sam.pr, { number: 12, url: "https://github.com/x/y/pull/12" });
  assert.deepStrictEqual(sam.last_commit, { sha: "abc1234def", date: "2026-10-22T09:00:00Z", message: "Lidar: smooth scans" });
  assert.deepStrictEqual([max.person, max.pages, max.pr], ["max", ["home", "voice"], null]);
});

test("branches: an unknown author has no person", () => {
  const got = branches([ref("x", "2026-10-22T09:00:00Z", "Stranger", "s@example.com")], () => [1, []]);
  assert.strictEqual(got[0].person, null);
  assert.strictEqual(got[0].author, "Stranger");
});

test("summary: first sentence as plain text", () => {
  const md = "# SLAM\n\nPart of: [Maps](maps.md)\n\n`slam_toolbox` builds a **2D map** from [/scan](x.md). More.\n";
  assert.strictEqual(bg.summarize(md), "slam_toolbox builds a 2D map from /scan.");
});

test("summary: a short first sentence takes the next", () => {
  assert.strictEqual(bg.summarize("Welcome! Notes is an app. It syncs."), "Welcome! Notes is an app.");
});

test("summary: long sentences are cut at 240 characters", () => {
  const s = bg.summarize("word ".repeat(100).trim() + ".");
  assert.strictEqual(s.length, 240);
  assert.ok(s.endsWith("..."));
});

test("front matter: inline lists, block lists and comments", () => {
  const [inline] = bg.parseFrontMatter("---\ntitle: 'A'\nparent: home   # hub\ncode: [src/a/**, \"src/b\"]\n---\nBody", "a.md");
  assert.deepStrictEqual({ ...inline }, { title: "A", parent: "home", code: ["src/a/**", "src/b"] });
  const [block, body] = bg.parseFrontMatter("---\ntitle: B\ncode:\n  - src/a/**\n  - 'src/b'  # second\nparent: home\n---\n\nBody", "b.md");
  assert.deepStrictEqual({ ...block }, { title: "B", code: ["src/a/**", "src/b"], parent: "home" });
  assert.strictEqual(body, "Body");
  assert.deepStrictEqual(bg.parseFrontMatter("# No front matter", "c.md"), [null, "# No front matter"]);
});

// ---------------------------------------------------------------- whole builds

async function withRepo(fn) {
  const repo = makeRepo();
  try {
    return await fn(repo.root);
  } finally {
    repo.cleanup();
  }
}
const build = (root, extra) => bg.buildGraph({ root, env: {}, warn: () => {}, ...extra });

test("builds the fixture repo: pages, team, history and branches", () =>
  withRepo(async (root) => {
    const g = await build(root);
    assert.strictEqual(g.repo, "acme/notes-app"); // from the origin remote, not a fixed name
    assert.deepStrictEqual([g.title, g.center], ["Oak", "oak"]); // README's heading; hubs name it "oak"
    assert.deepStrictEqual([g.branch, g.base, g.published], ["master", "master", true]);
    assert.deepStrictEqual(g.nodes.map((n) => n.id), ["oak", "keyboard-teleop", "movement", "object-detection", "senses"]);
    const node = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    assert.deepStrictEqual([node.senses.hub, node.senses.depth, node["object-detection"].hub, node["object-detection"].depth], ["senses", 1, "senses", 2]);
    assert.deepStrictEqual(node["object-detection"].backlinks, ["movement", "senses"]);
    assert.ok(g.edges.some((e) => e.source === "movement" && e.target === "object-detection" && e.kind === "link"));
    assert.strictEqual(node["keyboard-teleop"].last_change.person, "ben");
    assert.deepStrictEqual(g.recent.slice(0, 2).map((r) => [r.message, r.person]), [
      ["Object detection: bump a dependency", null], // a bot is nobody on the team
      ["Keyboard teleop: arrow keys", "ben"],
    ]);
    assert.deepStrictEqual(g.people.map((p) => p.id), ["ana", "ben"]); // the team file is the whole team
    const ana = g.people.find((p) => p.id === "ana");
    assert.deepStrictEqual([ana.past, ana.worked_on[0]], [["senses"], "senses"]);
    assert.ok(ana.contributed.includes("object-detection"));
    assert.deepStrictEqual(g.branches.map((b) => [b.name, b.person, b.ahead, b.pages]), [["ana/feat/boxes", "ana", 1, ["object-detection"]]]);
    assert.deepStrictEqual([g.work, g.questions], [[], []]); // no token, no GitHub
  }));

test("a repo without a GitHub remote has no repo name", () =>
  withRepo(async (root) => {
    require("./helpers").git(root, ["remote", "set-url", "origin", "/somewhere/else.git"]);
    const g = await build(root);
    assert.strictEqual(g.repo, null);
  }));

test("WIKI_BRANCH and GITHUB_REF_NAME set the branch the links point at", () =>
  withRepo(async (root) => {
    assert.deepStrictEqual(((g) => [g.branch, g.published])(await build(root, { env: { WIKI_BRANCH: "main" } })), ["main", true]);
    assert.strictEqual((await build(root, { env: { GITHUB_REF_NAME: "feat/x" } })).branch, "feat/x");
  }));

test("a page saved with a byte order mark is still a page", () =>
  withRepo(async (root) => {
    const file = path.join(root, "docs/wiki/movement.md");
    fs.writeFileSync(file, "﻿" + fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    const g = await build(root);
    const movement = g.nodes.find((n) => n.id === "movement");
    assert.ok(movement, "movement page missing");
    assert.ok(!movement.markdown.includes("\r"));
  }));

test("stops with a plain message on broken pages", () =>
  withRepo(async (root) => {
    const broken = async (file, text, message) => {
      const before = fs.readFileSync(path.join(root, file), "utf8");
      write(root, file, text);
      await assert.rejects(build(root), (err) => err instanceof bg.WikiError && message.test(err.message));
      write(root, file, before);
    };
    await broken("docs/wiki/movement.md", "---\nparent: home\n---\n", /needs both 'title' and 'parent'/);
    await broken("docs/wiki/movement.md", "---\ntitle: M\nparent: nowhere\n---\n", /no page called 'nowhere'/);
    await broken("docs/wiki/movement.md", "---\ntitle: M\nparent: home\n---\n[x](gone.md)\n", /links to 'gone.md', but that page does not exist/);
    await broken("docs/wiki/movement.md", "---\ntitle: M\nparent: home\n", /never closes it/);
    await broken("docs/wiki/senses.md", "---\ntitle: S\nparent: object-detection\n---\n", /loop back on themselves/);
    write(root, "docs/wiki/Bad_Name.md", "---\ntitle: B\nparent: home\n---\n");
    await assert.rejects(build(root), /lowercase words joined by '-'/);
    fs.rmSync(path.join(root, "docs/wiki/Bad_Name.md"));
    fs.rmSync(path.join(root, "docs/wiki"), { recursive: true });
    await assert.rejects(build(root), /no wiki folder at docs\/wiki/);
  }));

test("broken links: a wiki page's link or any link into the wiki must resolve; README's other links only warn", () =>
  withRepo(async (root) => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    // README.md links to a repo file that is not there: a warning, the build goes on
    write(root, "README.md", readme + "\nSee [the guide](CONTRIBUTING.md) and [old notes](docs/notes/old.md).\n");
    const warnings = [];
    const g = await build(root, { warn: (m) => warnings.push(m) });
    assert.strictEqual(g.nodes.length, 5);
    assert.deepStrictEqual(warnings, [
      "README.md links to 'CONTRIBUTING.md', but there is no such file in the repo.",
      "README.md links to 'docs/notes/old.md', but there is no such file in the repo.",
    ]);
    assert.strictEqual(g.missing, undefined, "not a missing page: README's own links are the project's business");
    // README.md links into the wiki folder: that page must exist
    write(root, "README.md", readme + "\nSee [Search](docs/wiki/search.md).\n");
    await assert.rejects(build(root), /README\.md links to 'docs\/wiki\/search\.md', but that page does not exist/);
    write(root, "README.md", readme);
    // a wiki page's links are the wiki's own, wherever they point
    write(root, "docs/wiki/movement.md", "---\ntitle: M\nparent: oak\n---\n[Guide](../../CONTRIBUTING.md)\n");
    await assert.rejects(build(root), /docs\/wiki\/movement\.md links to '..\/..\/CONTRIBUTING\.md', but that page does not exist/);
  }));

test("broken links with brokenLinks: \"warn\" (hypatia serve): listed as missing, the build goes on", () =>
  withRepo(async (root) => {
    write(root, "docs/wiki/movement.md", "---\ntitle: Movement\nparent: oak\n---\nNext: [Stairs](stairs.md).\n");
    const g = await build(root, { brokenLinks: "warn" });
    assert.ok(g.nodes.some((n) => n.id === "movement" && /Stairs/.test(n.markdown)), "the page with the link still updates");
    assert.deepStrictEqual(g.missing, [
      { from: "docs/wiki/movement.md", target: "stairs.md", path: "docs/wiki/stairs.md", message: "docs/wiki/movement.md links to 'stairs.md', but that page does not exist." },
    ]);
    await assert.rejects(build(root), /links to 'stairs.md', but that page does not exist/, "the default (check, build) still stops");
    await assert.rejects(build(root, { publish: true }), /links to 'stairs.md'/);
  }));

test("links inside code blocks and to normal repo files are not wiki links", () =>
  withRepo(async (root) => {
    const g = await build(root); // object-detection.md has both
    assert.ok(!g.edges.some((e) => e.target === "missing"));
  }));

test("Markdown in the wiki folder without front matter is a normal doc that pages may link to", () =>
  withRepo(async (root) => {
    write(root, "docs/wiki/Home.md", "# An older wiki page, no front matter\n");
    write(root, "docs/wiki/movement.md", "---\ntitle: Movement\nparent: oak\n---\nSee [the old home](Home.md).\n");
    const g = await build(root);
    assert.ok(!g.nodes.some((n) => n.id === "Home" || n.title.startsWith("An older")));
  }));

test("the data says whether GitHub was read, so the site can tell 'nothing open' from 'no access'", () =>
  withRepo(async (root) => {
    assert.strictEqual((await build(root)).github, false);
    const real = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, statusText: "OK", headers: new Map(), json: async () => [] });
    try {
      const g = await build(root, { token: "t", repo: "acme/notes-app" });
      assert.deepStrictEqual([g.github, g.work], [true, []]);
    } finally {
      global.fetch = real;
    }
  }));

test("stamps: each node carries its page's stamp state and stored stamp", () =>
  withRepo(async (root) => {
    const seen = [];
    const pageStamps = (r, pages) => {
      seen.push(r, pages);
      return new Map([
        ["docs/wiki/movement.md", { state: "stale", stored: "aaaaaaaaaaaa", actual: "bbbbbbbbbbbb" }],
        ["docs/wiki/senses.md", { state: "unverified", stored: null, actual: "cccccccccccc" }],
        ["docs/wiki/keyboard-teleop.md", { state: "current", stored: "dddddddddddd", actual: "dddddddddddd" }],
      ]);
    };
    const g = await build(root, { pageStamps });
    assert.strictEqual(seen[0], path.resolve(root));
    assert.ok(seen[1].some((p) => p.path === "docs/wiki/movement.md" && Array.isArray(p.code)));
    const stamp = Object.fromEntries(g.nodes.map((n) => [n.id, n.stamp]));
    assert.deepStrictEqual(stamp, {
      oak: { state: "none", stored: null },
      "keyboard-teleop": { state: "current", stored: "dddddddddddd" },
      movement: { state: "stale", stored: "aaaaaaaaaaaa" },
      "object-detection": { state: "none", stored: null }, // not in the map
      senses: { state: "unverified", stored: null },
    });
  }));

test("stamps: without stamp data every node is \"none\"", () =>
  withRepo(async (root) => {
    const g = await build(root, { pageStamps: () => null });
    assert.ok(g.nodes.every((n) => n.stamp.state === "none" && n.stamp.stored === null));
    // the real lib/stamp.js, or none at all: always one of the four states
    const states = new Set(["current", "stale", "unverified", "none"]);
    assert.ok((await build(root)).nodes.every((n) => states.has(n.stamp.state)));
    if (!fs.existsSync(path.join(__dirname, "../lib/stamp.js"))) assert.ok((await build(root)).nodes.every((n) => n.stamp.state === "none"));
  }));
