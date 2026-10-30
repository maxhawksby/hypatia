#!/usr/bin/env node
// Hypatia: a graph-style team wiki for any git repo.
//
//   hypatia serve [--port <n>] [--no-open]   open this repo's wiki locally, with live reload
//   hypatia build [--out <folder>]           write the site and its data to a folder (default _site)
//   hypatia check [--base <ref>] [--warn] [--no-drift] check the pages and the privacy guard without writing anything
//   hypatia verify <page.md>... | --all      stamp pages as checked against their code
//   hypatia mirror --out <folder>            write the pages as a GitHub Wiki (the Wiki tab)
//   hypatia ping [--dry-run]                 post a review request or question to Discord (in GitHub Actions)
//   hypatia init [--yes] [--dry-run]         set Hypatia up in this repo
//   hypatia upgrade [--yes] [--dry-run]      bring the files init installed up to this version
//   hypatia protect [--yes] [--dry-run]      make the wiki check required on the default branch
//   hypatia hooks install | remove           warn before each git push (never blocks it)
//
// Run it from anywhere inside the repo; it works on the repo's top folder.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildGraph, describe, WikiError } = require("../lib/build-graph");
const { serve, graphScript, SITE } = require("../lib/serve");
const { loadConfig } = require("../lib/team");
const privacy = require("../lib/privacy");
const { init } = require("../lib/init");
const { upgrade, upgradeNotice } = require("../lib/upgrade");
const { protect } = require("../lib/protect");
const { hooks } = require("../lib/hooks");
const { lint, repoFiles } = require("../lib/lint");
const drift = require("../lib/drift");
const { verifyCommand } = require("../lib/stamp");
const { baseRef } = require("../lib/build-graph");
const { mirrorCommand } = require("../lib/mirror");
const { pingCommand } = require("../lib/ping");
const { updateCheck } = require("../lib/update-check");

// One line per command for the overview, in the order people need them.
const COMMANDS = {
  init: "Set Hypatia up in this repo",
  serve: "Open the wiki in your browser, with live reload",
  check: "Check the pages for problems and personal data",
  verify: "Mark pages as checked against their code",
  build: "Write the website to a folder",
  upgrade: "Bring the installed files up to this version",
  protect: "Make the wiki check required before merging",
  hooks: "Warn before each git push on this computer",
  mirror: "Copy the pages into the repo's GitHub Wiki",
  ping: "Post review requests and questions to Discord",
};

// The full usage and behaviour of each command, for "hypatia help <command>".
const DETAILS = {
  init: `hypatia init [--dry-run] [--yes] [--public | --private] [--runner "<command>"] [--with check,mirror,ping]
    Sets Hypatia up in this repo: a docs/wiki/ folder with a starter page,
    the wiki-keeper agent skill, a way to open the wiki locally, the wiki
    check on every pull request, and "drift: warn" in docs/hypatia.yml (the
    check lists pages that fell behind their code, without failing). A
    public repo also gets the GitHub Pages workflow and the website link in
    its About box, after you say yes. Never overwrites a file; safe to run
    again. --dry-run only prints the plan.
    --with adds optional GitHub workflows to any repo: mirror (the GitHub
    Wiki tab) and ping (Discord posts).`,
  serve: `hypatia serve [--port <number>] [--no-open]
    Builds the wiki for this repo, serves it at http://localhost:4410/,
    opens your browser and reloads it when README.md, docs/wiki/ or
    docs/hypatia.yml change. Stop it with Ctrl+C.`,
  check: `hypatia check [--base <ref>] [--warn] [--no-drift]
    Checks the wiki pages (front matter, parents, links, code: paths that
    match no file) and runs the privacy guard, and says what to fix. Also
    warns about hub pages README.md does not lead to, and counts TODO(
    markers. Writes nothing; exits with 1 when a page has a problem.
    With "drift: warn" or "drift: error" in docs/hypatia.yml it also lists
    pages whose code changed since their verified: stamp, or that have
    none; error (or --base, when the config sets nothing) makes them fail
    the check, --warn only lists them. --base <ref> (default: the pull
    request's base branch) adds what changed in each page's files since
    <ref>. A pull request description (HYPATIA_PR_BODY or PR_BODY) can
    skip one page with "wiki: no change needed for <page.md> - <reason>".
    With "coverage: src" it fails when a top-level folder in src/ has no
    page. --no-drift skips the stamp check.`,
  verify: `hypatia verify <page.md>... | --all
    Stamps each page as checked against the code its code: covers: writes
    "verified: <stamp>" in its front matter and changes nothing else. Run
    it after rereading the page against that code and updating it, so
    hypatia check knows the page is current. --all stamps every page with
    code:. A page without code: is skipped.`,
  build: `hypatia build [--out <folder>]
    Writes the site and its data (graph.json, graph.js) to a folder,
    _site by default, ready for GitHub Pages or any static server. Pages
    marked "private: true" are left out. Stops, writing nothing, when the
    privacy guard finds an email, phone number, ID number or key.`,
  upgrade: `hypatia upgrade [--dry-run] [--yes] [--no-drift] [--public | --private]
    Brings the files init installed up to this version: rewrites the
    wiki-keeper skill and the wiki workflows from this version's templates,
    keeping the repo's branch and runner, adds the pull request check when
    it is missing, and offers "drift: warn" when the config has no drift:
    line (one already there is kept). Shows the plan and asks first; a file
    edited by hand is marked, since its edits would be lost. --dry-run only
    prints the plan.`,
  protect: `hypatia protect [--dry-run] [--yes]
    Makes the "wiki-check" job a required check on the default branch, so a
    pull request can't merge while the check fails. Adds it to the branch
    protection already there, or else adds a ruleset; nothing else changes.
    Shows the change and asks first. Uses the GitHub CLI (gh); when gh is
    missing or GitHub says no (a private repo on a free plan can't require
    checks), it prints the steps to do it by hand.`,
  hooks: `hypatia hooks install | remove
    install writes a git pre-push hook that runs
    "hypatia check --warn --base origin/<default branch>" before each push,
    so you see what the pull request check would say. It never blocks the
    push. A pre-push hook that is not Hypatia's is left alone; Hypatia
    prints the lines to add to it. remove takes Hypatia's hook out.`,
  mirror: `hypatia mirror --out <folder> [--repo <owner/name>] [--branch <name>]
    Writes the published pages into a clone of the repo's GitHub Wiki
    (<repo>.wiki.git): README.md becomes Home, links point at wiki pages or
    GitHub, and each page links back to its file. Removes pages that are
    gone. Stops, writing nothing, when the privacy guard finds something.`,
  ping: `hypatia ping [--dry-run] [--event <file>]
    In GitHub Actions: posts to Discord when a pull request asks for review
    or an issue is labelled "question", @mentioning people whose
    discord_id is in docs/hypatia.yml. Webhooks come from the
    DISCORD_REVIEW_WEBHOOK_URL / DISCORD_QUESTIONS_WEBHOOK_URL secrets;
    with none set it says so and passes. --dry-run prints the post.`,
};

const HELP = `Hypatia - a graph-style team wiki for any git repo.

Usage: hypatia <command> [options], from anywhere inside a repo.

Commands:
${Object.entries(COMMANDS)
  .map(([name, line]) => `  ${name.padEnd(9)}${line}`)
  .join("\n")}

Run "hypatia help <command>" for a command's options and details,
or "hypatia --version" for the version.
Docs: https://maxhawksby.github.io/hypatia/`;

const TEAM_NOTE = `The team comes from git history, and from GitHub when it can be read. The
optional docs/hypatia.yml sets the title, names, colors and focus lines.

GitHub data (who is working on what, questions, logins) is read when
GITHUB_TOKEN is set or the GitHub CLI is signed in (gh auth login).`;

// A known command close to a mistyped one ("serv", "chekc"), or null.
function closest(word) {
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = next;
      }
    }
    return row[b.length];
  };
  let best = null;
  for (const name of Object.keys(COMMANDS)) {
    const d = distance(word.toLowerCase(), name);
    if (d <= 2 && (!best || d < best.d)) best = { name, d };
  }
  return best && best.name;
}

// The details of one command, with the team note where it matters.
function commandHelp(name) {
  return ["serve", "build"].includes(name) ? `${DETAILS[name]}\n\n${TEAM_NOTE}` : DETAILS[name];
}

// The repo's top folder, or the current folder outside git.
function repoRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : path.resolve(cwd);
}

// Hypatia is set up when the repo has its wiki folder or its agent skill.
const installed = (root) => ["docs/wiki", ".claude/skills/wiki-keeper/SKILL.md"].some((rel) => fs.existsSync(path.join(root, rel)));

const NOT_INSTALLED = `hypatia: Hypatia isn't set up in this repo yet.

To install it, paste this into your coding agent (Claude Code, Codex, Cursor):

  Install Hypatia in this repo by following https://raw.githubusercontent.com/maxhawksby/hypatia/main/INSTALL-AGENT.md

Or set it up by hand: npx hypatia init`;

function parseBuildArgs(argv) {
  const opts = { out: "_site" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a.startsWith("--out=")) {
      opts.out = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (!opts.out) throw new Error("--out needs a folder name.");
    } else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option "${a}". Try --out <folder>.`);
  }
  return opts;
}

// `hypatia build`: the site files plus this repo's data, in one folder. The
// GitHub token comes from GITHUB_TOKEN only (as in GitHub Actions).
async function build(root, argv) {
  let opts;
  try {
    opts = parseBuildArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    console.log("hypatia build [--out <folder>]");
    return 0;
  }
  let graph;
  try {
    graph = await buildGraph({ root, token: process.env.GITHUB_TOKEN || null, publish: true });
  } catch (err) {
    if (!(err instanceof WikiError)) throw err;
    console.error(`hypatia: ${err.message}`);
    return 1;
  }
  const hits = privacy.scanSite(root, graph, { allow: loadConfig(root).allow });
  if (hits.length) {
    console.error(privacyReport(hits, "Nothing was written: the site would publish"));
    return 1;
  }
  const out = path.resolve(process.cwd(), opts.out);
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(SITE)) fs.copyFileSync(path.join(SITE, name), path.join(out, name));
  fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify(graph, null, 1), "utf8");
  fs.writeFileSync(path.join(out, "graph.js"), graphScript(graph), "utf8");
  const shown = path.relative(process.cwd(), out);
  console.log(`Wrote ${shown && !shown.startsWith("..") ? shown : out}: ${describe(graph)}`);
  return 0;
}

function parseCheckArgs(argv) {
  const opts = { base: null, noDrift: false, warn: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" || a.startsWith("--base=")) {
      opts.base = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (!opts.base) throw new Error("--base needs a branch or commit, e.g. --base origin/main.");
    } else if (a === "--no-drift") opts.noDrift = true;
    else if (a === "--warn") opts.warn = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option "${a}". Try --base <ref>, --warn or --no-drift.`);
  }
  return opts;
}

// How the drift check runs: { mode, base, baseAsked }. The mode comes from
// the config ("off", "warn", "error"); --warn makes it warn, --base turns it
// on (as error) when the config leaves it off, and --no-drift turns it off.
// The base only adds what changed to each stale page: --base, else the pull
// request's base in GitHub Actions, else origin's default branch when it
// exists.
function driftOptions(root, opts, config, env = process.env) {
  if (opts.noDrift) return { mode: "off", base: null, baseAsked: false };
  let mode = config.drift;
  if (opts.warn) mode = "warn";
  else if (opts.base && mode === "off") mode = "error";
  if (mode === "off") return { mode, base: null, baseAsked: false };
  if (opts.base) return { mode, base: opts.base, baseAsked: true };
  if (env.GITHUB_BASE_REF) return { mode, base: `origin/${env.GITHUB_BASE_REF}`, baseAsked: false };
  const ref = baseRef(root);
  const found = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root, windowsHide: true }).status === 0;
  return { mode, base: found ? ref.replace(/^refs\/remotes\//, "") : null, baseAsked: false };
}

// `hypatia check`: the same checks as a build, nothing written, no GitHub.
async function check(root, argv) {
  let opts;
  try {
    opts = parseCheckArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    console.log("hypatia check [--base <ref>] [--warn] [--no-drift]");
    return 0;
  }
  if (!installed(root)) {
    console.error(NOT_INSTALLED);
    return 1;
  }
  try {
    const excluded = [];
    const graph = await buildGraph({ root, token: null, publish: true, excluded, warn: (msg) => console.error(`hypatia: ${msg}`) });
    const { allow } = loadConfig(root);
    const hits = privacy.scanSite(root, graph, { allow });
    const logins = graph.people.map((p) => p.github);
    const local = privacy.scanFiles(root, excluded.map((e) => e.path), { allow, logins });
    if (local.length) {
      console.error(`hypatia: private pages (never published) mention:\n${privacy.describeHits(local).map((l) => "  " + l).join("\n")}`);
    }
    const found = lint(root, graph);
    const config = loadConfig(root);
    const codePages = drift.codePages(root, graph, excluded.map((e) => e.path));
    const driftRun = drift.driftCheck(root, codePages, {
      ...driftOptions(root, opts, config),
      prBody: process.env.HYPATIA_PR_BODY || process.env.PR_BODY || "",
      defaultBranch: drift.suggestedBase(root),
    });
    found.errors.push(...driftRun.errors);
    if (config.driftLegacy && !opts.noDrift) {
      found.warnings.push(`"drift: ${config.driftLegacy}" is from an older Hypatia and now means warn; set "drift: error" once every page is verified.`);
    }
    found.warnings.push(...driftRun.warnings);
    for (const n of driftRun.notes) console.error(`hypatia: ${n}`);
    const driftNote = driftRun.summary;
    if (config.coverage.length) {
      const files = repoFiles(root);
      if (files) found.errors.push(...drift.coverageProblems(codePages, config.coverage, files));
    }
    for (const w of found.warnings) console.error(`hypatia: warning: ${w}`);
    const notice = upgradeNotice(root);
    if (notice) console.error(notice);
    for (const e of found.errors) console.error(`hypatia: ${e}`);
    const { count, pages } = found.todos;
    const todoLine = count ? `${count} TODO( ${count === 1 ? "marker" : "markers"} left in ${pages.length} ${pages.length === 1 ? "page" : "pages"}: ${pages.join(", ")}.` : "";
    if (hits.length) console.error(privacyReport(hits, "The wiki check failed: the public site would show"));
    if (hits.length || found.errors.length) {
      if (!hits.length) console.error("hypatia: the wiki check failed.");
      if (todoLine) console.log(todoLine);
      return 1;
    }
    const kept = excluded.length ? `, ${excluded.length} private ${excluded.length === 1 ? "page" : "pages"} left out` : "";
    console.log(`Wiki check passed: ${graph.nodes.length} pages, ${graph.edges.length} links and parents${kept}, no personal data or keys found.${driftNote}`);
    if (todoLine) console.log(todoLine);
    return 0;
  } catch (err) {
    if (!(err instanceof WikiError)) throw err;
    console.error(`hypatia: ${err.message}`);
    return 1;
  }
}

// Runs a command people type by hand, then says when a newer Hypatia is on
// npm. The check starts first and runs alongside, so it adds no wait unless
// the registry is slower than the command (and then at most its timeout).
async function withUpdateNotice(command, run) {
  const pending = updateCheck(command);
  const code = await run();
  const info = await pending;
  if (info) console.error(info.line);
  return code;
}

// What the privacy guard found, masked, and how to clear it.
function privacyReport(hits, lead) {
  return (
    `hypatia: ${lead} personal data or secrets:\n` +
    privacy.describeHits(hits).map((l) => "  " + l).join("\n") +
    "\n\nRemove them from the page (use made-up values like user@example.com), mark the page" +
    '\n"private: true" to keep it off the website, or, if a value is safe to publish, list it' +
    "\nunder allow: in docs/hypatia.yml." +
    (hits.some((h) => h.file.toLowerCase() === "readme.md") ? "\nREADME.md is the home page and is always published: edit it instead." : "") +
    (hits.some((h) => !h.page)
      ? "\nSite data (commit messages, branch names, issue titles) is published too. Git history can't be edited" +
        "\nsafely, so list a value already in it under allow: if it is safe, and keep it out of new ones."
      : "")
  );
}

async function main(argv) {
  const [command, ...rest] = argv;
  const help = (a) => a === "--help" || a === "-h";
  if (command === "help" && rest[0]) {
    if (DETAILS[rest[0]]) {
      console.log(commandHelp(rest[0]));
      return 0;
    }
    console.error(`Unknown command "${rest[0]}".\n\n${HELP}`);
    return 2;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(require("../lib/init").VERSION);
    return 0;
  }
  if (!command || help(command) || command === "help") {
    console.log(HELP);
    return command ? 0 : 2;
  }
  if (DETAILS[command] && rest.some(help)) {
    console.log(commandHelp(command));
    return 0;
  }
  const root = repoRoot(process.cwd());
  if (command === "init") return withUpdateNotice(command, () => init(root, rest));
  if (command === "upgrade") return withUpdateNotice(command, () => upgrade(root, rest));
  if (command === "protect") return protect(root, rest);
  if (command === "hooks") return hooks(root, rest);
  if (command === "serve") return serve(root, rest);
  if (command === "build") return build(root, rest);
  if (command === "check") return withUpdateNotice(command, () => check(root, rest));
  if (command === "verify") return verifyCommand(root, rest);
  if (command === "mirror") return mirrorCommand(root, rest);
  if (command === "ping") return pingCommand(root, rest);
  const guess = closest(command);
  console.error(`Unknown command "${command}".${guess ? ` Did you mean "hypatia ${guess}"?` : ""}\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
);
