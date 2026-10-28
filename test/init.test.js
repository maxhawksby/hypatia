// Tests for `hypatia init` (lib/init.js): what it sets up in public and
// private repos, that it never overwrites, that a dry run changes nothing and
// that GitHub is only changed after a yes. GitHub is a stand-in here: no test
// ever runs the real gh. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const { init, isLocalRunner, withWikiScript, pagesUrl } = require("../lib/init");
const templates = require("../lib/templates");
const { makeRepo, write, git } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");
const RUNNER = "npx --yes acme-hypatia@1.0.0"; // a runner GitHub could download
const SKILL = ".claude/skills/wiki-keeper/SKILL.md";
const SITE_WORKFLOW = ".github/workflows/wiki-site.yml";

// A stand-in for gh with a repo's state on GitHub; it changes the state on
// writes so a second run sees the first one's work. gh.writes() lists them.
function fakeGh(state = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (state.fail) return { ok: false, out: "", err: "gh: To get started with GitHub CLI, please run: gh auth login" };
    if (args[0] === "repo" && args[1] === "view") {
      const repo = { visibility: state.visibility || "PRIVATE", defaultBranchRef: { name: state.branch || "main" }, homepageUrl: state.homepage || "", url: "" };
      return { ok: true, out: JSON.stringify(repo), err: "" };
    }
    if (args[0] === "api" && !args.includes("-X")) {
      return state.pages ? { ok: true, out: JSON.stringify(state.pages), err: "" } : { ok: false, out: "", err: "gh: Not Found (HTTP 404)" };
    }
    if (args[0] === "api" && args[2] === "POST") {
      state.pages = { build_type: "workflow", html_url: "https://acme.github.io/notes-app/" };
      return { ok: true, out: JSON.stringify(state.pages), err: "" };
    }
    if (args[0] === "api" && args[2] === "PATCH") {
      const field = args[args.indexOf("-f") + 1];
      state.homepage = field.slice(field.indexOf("=") + 1);
      return { ok: true, out: "{}", err: "" };
    }
    return { ok: false, out: "", err: `unexpected gh ${args.join(" ")}` };
  };
  gh.calls = calls;
  gh.writes = () => calls.filter((a) => a.includes("-X"));
  return gh;
}

// Runs init with stand-ins; returns { code, out }.
async function run(root, argv, { gh = fakeGh(), answer = null } = {}) {
  const lines = [];
  const asked = [];
  const code = await init(root, argv, {
    gh,
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    log: (s) => lines.push(s),
  });
  return { code, out: lines.join("\n"), asked };
}

// Every file under root (but .git) with its text, to prove nothing changed.
function snapshot(root) {
  const out = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = fs.readFileSync(p, "utf8");
    }
  })(root);
  return out;
}

function freshRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-init-"));
  git(root, ["init", "-q", "-b", "trunk"]);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("a fresh repo gets a starter page and the skill, passes the check, and a second run changes nothing", async () => {
  const repo = freshRepo();
  try {
    const gh = fakeGh();
    const first = await run(repo.root, ["--runner", RUNNER], { gh });
    assert.strictEqual(first.code, 0, first.out);
    assert.ok(exists(repo.root, "docs/wiki/start-here.md"));
    assert.ok(exists(repo.root, SKILL));
    assert.ok(!exists(repo.root, ".github"), "no website for a repo that is not public");
    assert.deepStrictEqual(gh.calls, [], "no GitHub remote: gh is never run");
    assert.match(first.out, /private \(no GitHub remote\), default branch trunk/);
    assert.match(first.out, /No website: this repo is private/);
    assert.match(first.out, new RegExp(`Open the wiki on your computer: ${RUNNER} serve`));

    const page = read(repo.root, "docs/wiki/start-here.md");
    assert.match(page, /^---\ntitle: Start here\nparent: home\n---\n/);
    const skill = read(repo.root, SKILL);
    assert.deepStrictEqual(templates.placeholders(skill), []);
    assert.doesNotMatch(skill, /Hypatia template/, "the note to template readers is taken out");
    assert.match(skill, /origin\/trunk\.\.\.HEAD/);
    assert.match(skill, new RegExp(`${RUNNER} check`));

    const check = spawnSync(process.execPath, [CLI, "check"], { cwd: repo.root, encoding: "utf8" });
    assert.strictEqual(check.status, 0, check.stderr);
    assert.match(check.stdout, /Wiki check passed: 2 pages/);
    assert.strictEqual(check.stderr, "", "a brand-new repo builds without warnings");

    const before = snapshot(repo.root);
    const again = await run(repo.root, ["--runner", RUNNER], { gh });
    assert.strictEqual(again.code, 0, again.out);
    assert.deepStrictEqual(snapshot(repo.root), before);
    assert.match(again.out, /= docs\/wiki\/\s+already has 1 wiki page; left as is/);
    assert.match(again.out, /= \.claude\/skills\/wiki-keeper\/SKILL\.md\s+already there; left as is/);
    assert.match(again.out, /Nothing new to set up/);
  } finally {
    repo.cleanup();
  }
});

test("init never overwrites a page, the skill or a wiki script that is already there", async () => {
  const repo = makeRepo({ generic: true });
  try {
    write(repo.root, SKILL, "my own skill\n");
    write(repo.root, "package.json", '{\n    "name": "notes",\n    "scripts": { "wiki": "my-wiki" }\n}\n');
    const before = snapshot(repo.root);
    const r = await run(repo.root, ["--runner", RUNNER, "--yes"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(snapshot(repo.root), before);
    assert.match(r.out, /already has 4 wiki pages; left as is/);
    assert.match(r.out, /already there and different from this version; left as is/);
    assert.match(r.out, /already has a "wiki" script of its own; left as is/);
    assert.ok(!exists(repo.root, "docs/wiki/start-here.md"), "no starter page next to real pages");
  } finally {
    repo.cleanup();
  }
});

test("older notes in the wiki folder are linked from the starter page and left as they are", async () => {
  const repo = freshRepo();
  try {
    write(repo.root, "docs/wiki/Home.md", "# Old wiki home\n");
    const first = await run(repo.root, ["--runner", RUNNER]);
    assert.strictEqual(first.code, 0, first.out);
    assert.match(read(repo.root, "docs/wiki/start-here.md"), /- \[Home\]\(Home\.md\)/);
    assert.strictEqual(read(repo.root, "docs/wiki/Home.md"), "# Old wiki home\n");
    const check = spawnSync(process.execPath, [CLI, "check"], { cwd: repo.root, encoding: "utf8" });
    assert.strictEqual(check.status, 0, check.stderr);
  } finally {
    repo.cleanup();
  }
});

test("a dry run prints the plan and changes nothing, on disk or on GitHub", async () => {
  const repo = makeRepo({ generic: true });
  try {
    fs.rmSync(path.join(repo.root, "docs", "wiki"), { recursive: true });
    write(repo.root, "package.json", '{ "name": "notes" }\n');
    const gh = fakeGh({ visibility: "PUBLIC" });
    const before = snapshot(repo.root);
    const r = await run(repo.root, ["--dry-run", "--yes", "--runner", RUNNER], { gh, answer: "y" });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(snapshot(repo.root), before);
    assert.deepStrictEqual(gh.writes(), []);
    assert.deepStrictEqual(r.asked, [], "a dry run asks nothing");
    assert.match(r.out, /Dry run: nothing was changed\. Run it without --dry-run to do the 8 \+ steps\./);
    for (const step of ["docs/wiki/start-here.md", SKILL, "package.json", SITE_WORKFLOW, ".github/workflows/wiki-refresh.yml", ".github/workflows/wiki-check.yml", "GitHub: Pages", "GitHub: About website"]) {
      assert.match(r.out, new RegExp(`\\+ ${step.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
    }
    assert.match(r.out, /set to https:\/\/acme\.github\.io\/notes-app\//);
  } finally {
    repo.cleanup();
  }
});

test("public repo: the website is set up only after a yes, and a second run sees it done", async () => {
  const repo = makeRepo({ generic: true });
  try {
    write(repo.root, "package.json", '{\n  "name": "notes",\n  "scripts": {\n    "test": "node t.js"\n  }\n}\n');
    const state = { visibility: "PUBLIC", branch: "master" };
    const gh = fakeGh(state);

    const no = await run(repo.root, ["--runner", RUNNER], { gh, answer: "n" });
    assert.strictEqual(no.code, 0, no.out);
    assert.strictEqual(no.asked.length, 1);
    assert.ok(!exists(repo.root, SITE_WORKFLOW));
    assert.deepStrictEqual(gh.writes(), []);
    assert.match(no.out, /OK, the public website is not set up/);
    assert.match(read(repo.root, "package.json"), /"wiki": "npx --yes acme-hypatia@1\.0\.0 serve"/, "local parts still happen");

    const yes = await run(repo.root, ["--runner", RUNNER], { gh, answer: "yes" });
    assert.strictEqual(yes.code, 0, yes.out);
    const site = read(repo.root, SITE_WORKFLOW);
    assert.deepStrictEqual(templates.placeholders(site), []);
    assert.doesNotMatch(site, /Hypatia template/);
    assert.match(site, /branches: \[master\]/);
    assert.match(site, /run: npx --yes acme-hypatia@1\.0\.0 build --out _site/);
    assert.match(read(repo.root, ".github/workflows/wiki-refresh.yml"), /branches-ignore: \[master\]/);
    assert.deepStrictEqual(gh.writes(), [
      ["api", "-X", "POST", "repos/acme/notes-app/pages", "-f", "build_type=workflow"],
      ["api", "-X", "PATCH", "repos/acme/notes-app", "-f", "homepage=https://acme.github.io/notes-app/"],
    ]);
    assert.match(yes.out, /Commit and push the new files to master\. GitHub then builds the website at https:\/\/acme\.github\.io\/notes-app\//);

    const before = snapshot(repo.root);
    const again = await run(repo.root, ["--runner", RUNNER], { gh, answer: "y" });
    assert.strictEqual(again.code, 0, again.out);
    assert.deepStrictEqual(snapshot(repo.root), before);
    assert.strictEqual(gh.writes().length, 2, "nothing more written to GitHub");
    assert.deepStrictEqual(again.asked, [], "nothing left to ask about");
    assert.match(again.out, /= GitHub: Pages\s+already on with Source: GitHub Actions/);
    assert.match(again.out, /= GitHub: About website\s+already https:\/\/acme\.github\.io\/notes-app\//);
  } finally {
    repo.cleanup();
  }
});

test("public repo: a website already in the About box is never replaced, and Pages from a branch is left alone", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const gh = fakeGh({ visibility: "PUBLIC", homepage: "https://notes.acme.dev", pages: { build_type: "legacy", html_url: "https://acme.github.io/notes-app/" } });
    const r = await run(repo.root, ["--runner", RUNNER, "--yes"], { gh });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(gh.writes(), []);
    assert.match(r.out, /left as https:\/\/notes\.acme\.dev \(not replaced\)/);
    assert.match(r.out, /publishing from a branch; switch Source to GitHub Actions yourself/);
    assert.match(r.out, /Settings > Pages > Source: GitHub Actions/);
    assert.ok(exists(repo.root, SITE_WORKFLOW));
  } finally {
    repo.cleanup();
  }
});

test("public repo with no terminal and no --yes: only the local parts happen", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const gh = fakeGh({ visibility: "PUBLIC" });
    const r = await run(repo.root, ["--runner", RUNNER], { gh, answer: null });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!exists(repo.root, ".github"));
    assert.deepStrictEqual(gh.writes(), []);
    assert.match(r.out, /No terminal to ask, so the public website is not set up\. Rerun with --yes/);
  } finally {
    repo.cleanup();
  }
});

test("private repo: no workflows, no GitHub changes, and it says how to open the wiki locally", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const gh = fakeGh({ visibility: "PRIVATE" });
    const r = await run(repo.root, ["--runner", RUNNER, "--yes"], { gh });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!exists(repo.root, ".github"));
    assert.deepStrictEqual(gh.writes(), []);
    assert.deepStrictEqual(gh.calls.map((a) => a.slice(0, 2)), [["repo", "view"]], "a private repo's Pages are not even read");
    assert.match(r.out, /private \(GitHub says so\)/);
    assert.match(r.out, /No website: this repo is private/);
  } finally {
    repo.cleanup();
  }
});

test("a runner on this computer never goes into a workflow, even with --yes", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const gh = fakeGh({ visibility: "PUBLIC" });
    const r = await run(repo.root, ["--runner", "node /home/me/hypatia/bin/hypatia.js", "--yes"], { gh });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!exists(repo.root, ".github"));
    assert.deepStrictEqual(gh.writes(), []);
    assert.match(r.out, /! \.github\/workflows\/wiki-site\.yml\s+not installed: GitHub can't run Hypatia from a folder on this computer/);
    assert.match(r.out, /No website yet: GitHub needs a Hypatia it can download/);
  } finally {
    repo.cleanup();
  }
});

test("by default, everything committed says npx hypatia, and the workflow pins this version", async () => {
  const repo = makeRepo({ generic: true });
  try {
    fs.rmSync(path.join(repo.root, "docs", "wiki"), { recursive: true });
    write(repo.root, "package.json", '{ "name": "notes" }\n');
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const r = await run(repo.root, ["--yes"], { gh: fakeGh({ visibility: "PUBLIC" }) });
    assert.strictEqual(r.code, 0, r.out);
    const here = path.join(__dirname, "..");
    const written = [r.out, ...["docs/wiki/start-here.md", SKILL, "package.json", SITE_WORKFLOW].map((f) => read(repo.root, f))];
    for (const text of written) {
      assert.ok(!text.includes(here), "no path on this computer in what is shared");
      assert.doesNotMatch(text, /node \S*hypatia\.js/);
    }
    assert.match(read(repo.root, "docs/wiki/start-here.md"), /`npx hypatia check`/);
    assert.match(read(repo.root, SKILL), /`npx hypatia serve`/);
    assert.strictEqual(JSON.parse(read(repo.root, "package.json")).scripts.wiki, "npx hypatia serve");
    assert.match(read(repo.root, SITE_WORKFLOW), new RegExp(`run: npx hypatia@${version.replace(/\./g, "\\.")} build --out _site`));
    assert.match(r.out, /Open the wiki on your computer: npm run wiki/);
    assert.match(r.out, /then run npx hypatia check\./);
    assert.match(r.out, /Link the wiki from README\.md, e\.g\. \[Start here\]\(docs\/wiki\/start-here\.md\)/);
    assert.ok(exists(repo.root, ".github/workflows/wiki-refresh.yml"), "a published runner can go into the workflows");
  } finally {
    repo.cleanup();
  }
});

test("when GitHub can't be read, init asks whether the repo is public, else keeps it private", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const unknown = await run(repo.root, ["--runner", RUNNER, "--dry-run"], { gh: fakeGh({ fail: true }), answer: null });
    assert.match(unknown.asked[0], /Is it public\? \[y\/N\]/);
    assert.match(unknown.out, /private \(GitHub could not be read, so it stays local; use --public to change that\)/);
    const said = await run(repo.root, ["--runner", RUNNER, "--dry-run"], { gh: fakeGh({ fail: true }), answer: "y" });
    assert.match(said.out, /public \(you said so\)/);
    assert.match(said.out, /! GitHub settings\s+not changed: could not read the repo on GitHub/);
    const flag = await run(repo.root, ["--runner", RUNNER, "--dry-run", "--private"], { gh: fakeGh({ visibility: "PUBLIC" }) });
    assert.match(flag.out, /private \(you said so\)/);
    assert.doesNotMatch(flag.out, /wiki-site\.yml/);
  } finally {
    repo.cleanup();
  }
});

test("init outside a git repo says so, and bad options are refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-nogit-"));
  try {
    const r = await run(dir, []);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /not in one\. Run `git init` first/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.strictEqual((await run(dir, ["--nope"])).code, 2);
    assert.strictEqual((await run(dir, ["--public", "--private"])).code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hypatia init runs from the CLI with a stand-in gh, and --dry-run writes nothing", () => {
  const repo = makeRepo({ generic: true });
  try {
    fs.rmSync(path.join(repo.root, "docs", "wiki"), { recursive: true });
    const env = { ...process.env, HYPATIA_GH: path.join(repo.root, "no-such-gh") };
    const before = snapshot(repo.root);
    const dry = spawnSync(process.execPath, [CLI, "init", "--dry-run"], { cwd: repo.root, env, encoding: "utf8", input: "" });
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Hypatia init for acme\/notes-app: private/);
    assert.deepStrictEqual(snapshot(repo.root), before);
    const real = spawnSync(process.execPath, [CLI, "init"], { cwd: path.join(repo.root, "src"), env, encoding: "utf8", input: "" });
    assert.strictEqual(real.status, 0, real.stderr);
    assert.ok(exists(repo.root, "docs/wiki/start-here.md"), "runs on the repo's top folder from anywhere inside it");
    assert.match(read(repo.root, SKILL), /`npx hypatia check`/);
  } finally {
    repo.cleanup();
  }
});

test("helpers: local runners, the Pages address and the package.json edit", () => {
  assert.ok(isLocalRunner("node /home/me/hypatia/bin/hypatia.js"));
  assert.ok(isLocalRunner('node "C:\\Users\\me\\hypatia\\bin\\hypatia.js"'));
  assert.ok(isLocalRunner("npx --yes ./hypatia"));
  assert.ok(!isLocalRunner("npx --yes hypatia@0.2.0"));
  assert.ok(!isLocalRunner("npx --yes github:acme/hypatia"));
  assert.strictEqual(pagesUrl("Acme/notes-app"), "https://acme.github.io/notes-app/");
  assert.strictEqual(pagesUrl("acme/Acme.github.io"), "https://acme.github.io/");
  assert.strictEqual(withWikiScript('{\n\t"name": "x"\n}', "w serve"), '{\n\t"name": "x",\n\t"scripts": {\n\t\t"wiki": "w serve"\n\t}\n}');
  assert.throws(() => withWikiScript("[1]", "w"), /not a JSON object/);
});

test("--with adds optional workflows to a private repo too, filled in, and never twice", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const gh = fakeGh({ visibility: "PRIVATE" });
    const r = await run(repo.root, ["--runner", RUNNER, "--with", "check,mirror", "--with=ping"], { gh });
    assert.strictEqual(r.code, 0, r.out);
    for (const name of ["check", "mirror", "ping"]) {
      const text = read(repo.root, `.github/workflows/wiki-${name}.yml`);
      assert.deepStrictEqual(templates.placeholders(text), [], name);
      assert.match(text, new RegExp(`${RUNNER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (check|mirror|ping)`), name);
    }
    assert.match(read(repo.root, ".github/workflows/wiki-check.yml"), /branches: \[main\]/);
    assert.ok(!exists(repo.root, SITE_WORKFLOW), "still no website for a private repo");
    assert.deepStrictEqual(gh.writes(), []);
    const again = await run(repo.root, ["--runner", RUNNER, "--with", "mirror"], { gh });
    assert.match(again.out, /= \.github\/workflows\/wiki-mirror\.yml\s+already there; left as is/);
    const bad = await run(repo.root, ["--with", "slack"], { gh });
    assert.strictEqual(bad.code, 2);
    assert.match(bad.out, /--with takes check, mirror, ping/);
  } finally {
    repo.cleanup();
  }
});
