// `hypatia upgrade`: brings the files `hypatia init` installed up to this
// version of Hypatia.
//
//   hypatia upgrade               print the plan, ask, then do it
//   hypatia upgrade --dry-run     print the plan only; nothing changes
//   hypatia upgrade --yes         no question: go ahead
//   hypatia upgrade --no-drift    leave the drift check as it is
//   hypatia upgrade --public | --private   say whether the repo has the public website
//
// It rewrites the wiki-keeper skill and every Hypatia workflow already in
// .github/workflows/ from this version's templates, keeping the project's
// values: the default branch, the config file and the runner (a pinned
// `npx hypatia@<old>` moves to this version; any other command is kept). A
// repo with the public website (wiki-site.yml, or --public) also gets the
// pull request check, wiki-check.yml, if it lacks it. Mirror and ping
// workflows are refreshed when present, never added. It offers to turn on
// the drift check (drift: true in the config), editing only that line.
//
// A file someone edited by hand is still replaced after the yes, and its
// line in the plan says those edits will be lost. It never reaches GitHub.
//
// upgradeNotice() is the one line `hypatia check` and `hypatia serve` print
// when the installed files are from an older Hypatia.
"use strict";

const fs = require("fs");
const path = require("path");
const templates = require("./templates");
const { repoSlug } = require("./build-graph");
const { loadConfig, CONFIG_FILES } = require("./team");
const init = require("./init");

const { VERSION, SKILL_FILE, SKILL_TEMPLATE } = init;

// Every workflow Hypatia installs: [template, file, what it does].
const WORKFLOWS = [];
for (const w of [...init.WORKFLOWS, ...Object.values(init.OPTIONAL)]) if (!WORKFLOWS.some(([, rel]) => rel === w[1])) WORKFLOWS.push(w);
const CHECK = init.OPTIONAL.check[1];
const SITE = ".github/workflows/wiki-site.yml";

// `npx hypatia@<version>` (with or without --yes): the runner init pins.
const PINNED_RE = /^npx\s+(?:(?:--yes|-y)\s+)?hypatia@(\S+)$/;
// The line in a workflow that runs Hypatia: "run: <runner> build ...".
const RUN_RE = /^[ \t]*run:[ \t]*(.+?)[ \t]+(?:build|check|mirror|ping)\b/m;

// ---------------------------------------------------------------- versions

// -1, 0 or 1, comparing the numbers in two versions (0.2.10 > 0.2.9).
function compareVersions(a, b) {
  const nums = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

// The Hypatia version that wrote an installed file: its stamp, else the
// version a workflow pins. { version, known, edited, hypatia }: version is
// null when unknown (a skill from before stamps), hypatia false when nothing
// says Hypatia wrote it.
function fileVersion(text, rel) {
  const stamp = templates.readStamp(text);
  if (stamp) return { version: stamp.version, edited: stamp.edited, hypatia: true };
  if (rel.endsWith(".md")) return { version: null, edited: null, hypatia: /hypatia/i.test(text) };
  const run = RUN_RE.exec(text);
  const pin = run && PINNED_RE.exec(run[1]);
  return { version: pin ? pin[1] : null, edited: null, hypatia: !!pin };
}

// The files init installed that are older than this version, as
// [{ rel, version }] (version null: older than stamps). Reads at most six
// small files, so it costs nothing next to a check.
function outdated(root) {
  const out = [];
  for (const rel of [SKILL_FILE, ...WORKFLOWS.map(([, r]) => r)]) {
    const text = readIf(path.join(root, rel));
    if (text === null) continue;
    const v = fileVersion(text, rel);
    if (!v.hypatia) continue;
    // a workflow with its own runner and no stamp says nothing about its age
    if (v.version === null && !rel.endsWith(".md")) continue;
    if (v.version === null || compareVersions(v.version, VERSION) < 0) out.push({ rel, version: v.version });
  }
  return out;
}

// The command this repo types to run Hypatia, from its skill (`X serve`), else
// its "wiki" npm script, else `npx hypatia`.
function repoCli(root) {
  const skill = readIf(path.join(root, SKILL_FILE));
  const m = skill && /`([^`\n]+?) (?:serve|check)`/.exec(skill);
  if (m) return m[1];
  try {
    const wiki = JSON.parse(readIf(path.join(root, "package.json")) || "{}").scripts.wiki;
    if (/ serve$/.test(wiki)) return wiki.slice(0, -" serve".length);
  } catch {
    // no package.json, or no wiki script
  }
  return init.defaultRunner().cli;
}

// One line when this repo's Hypatia files are from an older version, else
// null. Never throws: a notice must not break the command that prints it.
function upgradeNotice(root) {
  try {
    const old = outdated(root);
    if (!old.length) return null;
    const known = old.map((o) => o.version).filter(Boolean).sort(compareVersions);
    const from = known.length ? `from ${known[0]}` : "from an older Hypatia";
    return `hypatia: this project's Hypatia setup is ${from} (now ${VERSION}). Run '${repoCli(root)} upgrade' to update the agent skill and workflows.`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const opts = { dryRun: false, yes: false, drift: true, visibility: null };
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--no-drift") opts.drift = false;
    else if (a === "--public" || a === "--private") {
      if (opts.visibility && opts.visibility !== a.slice(2)) throw new Error("Use --public or --private, not both.");
      opts.visibility = a.slice(2);
    } else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option "${a}". Try --dry-run, --yes, --no-drift, --public or --private.`);
  }
  return opts;
}

// ---------------------------------------------------------------- facts

// What the installed files say about the project: the branch in their
// "branches:" lines, the skill's command, and each workflow's runner.
function readFacts(root, opts) {
  const texts = {};
  for (const [, rel] of WORKFLOWS) {
    const text = readIf(path.join(root, rel));
    if (text !== null) texts[rel] = text;
  }
  let branch = null;
  for (const text of Object.values(texts)) {
    const m = /^\s*branches(?:-ignore)?:\s*\[\s*([^\],\s]+)\s*\]/m.exec(text);
    if (m) {
      branch = m[1].replace(/^["']|["']$/g, "");
      break;
    }
  }
  branch = branch || init.defaultBranch(root, null);
  // the runners the workflows use; a custom one (from init --runner) is kept
  const runners = Object.values(texts)
    .map((t) => RUN_RE.exec(t))
    .filter(Boolean)
    .map((m) => m[1]);
  const custom = runners.find((r) => !PINNED_RE.test(r)) || null;
  const pinned = `npx hypatia@${VERSION}`;
  const runnerFor = (text) => {
    const m = text && RUN_RE.exec(text);
    if (!m) return custom || pinned;
    return PINNED_RE.test(m[1]) ? m[1].replace(/@\S+$/, `@${VERSION}`) : m[1];
  };
  const skill = readIf(path.join(root, SKILL_FILE));
  const cli = skill ? repoCli(root) : custom || repoCli(root);
  const visibility = opts.visibility || (texts[SITE] !== undefined ? "public" : "private");
  const values = init.templateValues(root, { slug: repoSlug(root), branch, cli });
  return { texts, branch, custom, runnerFor, values, visibility, skill };
}

// ---------------------------------------------------------------- config

// The config text with "drift: true", every other line kept as it was.
function withDrift(text) {
  if (text === null) return "# Hypatia's settings for this repo.\ndrift: true   # pull requests must update the pages whose code changed\n";
  if (/^drift:.*$/m.test(text)) return text.replace(/^drift:.*$/m, "drift: true");
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}drift: true\n`;
}

// ---------------------------------------------------------------- plan

// Every step: { mark, label, note, run }. "+" adds a file, "~" replaces or
// edits one, "=" already current, "!" not done (note says why).
function plan(root, facts, opts) {
  const steps = [];
  const file = (rel) => path.join(root, rel);
  const writeFile = (rel, before, text) => () => {
    if (readIf(file(rel)) !== before) return "changed while upgrade ran; left as is";
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), text);
    return null;
  };
  // the line for a file that exists: = when current, else ~ with how old it is
  // and whether hand edits would be lost
  const refresh = (rel, before, text, what) => {
    if (before === text) return steps.push({ mark: "=", label: rel, note: "already current" });
    const v = fileVersion(before, rel);
    const from = v.version ? `from ${v.version}` : "from an older version";
    let edits = "";
    if (v.edited) edits = `; it was edited by hand since Hypatia ${v.version} wrote it, and those edits will be lost`;
    else if (v.edited === null) edits = "; Hypatia can't tell whether it was edited by hand, so any edits made here will be lost";
    else if (v.version === VERSION) edits = "; this version wrote it with other values";
    steps.push({ mark: "~", label: rel, note: `${what}, ${from} to ${VERSION}${edits}`, run: writeFile(rel, before, text) });
  };

  // the agent skill
  const skill = templates.renderStamped(SKILL_TEMPLATE, facts.values, VERSION);
  if (facts.skill === null) steps.push({ mark: "+", label: SKILL_FILE, note: "wiki-keeper skill, so Claude keeps the pages true to the code", run: writeFile(SKILL_FILE, null, skill) });
  else refresh(SKILL_FILE, facts.skill, skill, "updates the agent skill");

  // the workflows already there, and the pull request check for a public site
  for (const [src, rel, what] of WORKFLOWS) {
    const before = facts.texts[rel];
    if (before === undefined && !(rel === CHECK && facts.visibility === "public")) continue;
    const runner = facts.runnerFor(before);
    if (init.isLocalRunner(runner)) {
      steps.push({ mark: "!", label: rel, note: `${before === undefined ? "not added" : "left as is"}: GitHub can't run Hypatia from a folder on this computer` });
      continue;
    }
    const text = templates.renderStamped(src, { ...facts.values, HYPATIA: runner }, VERSION);
    if (before === undefined) steps.push({ mark: "+", label: rel, note: `${what} (new in this version for repos with the website)`, run: writeFile(rel, null, text) });
    else refresh(rel, before, text, "updates the workflow");
  }

  // the drift check
  const config = loadConfig(root);
  const rel = config.file || CONFIG_FILES[0];
  const before = readIf(file(rel));
  const explicit = before !== null && /^drift:\s*(false|no|off)\b/im.exec(before);
  if (config.drift !== "off") steps.push({ mark: "=", label: rel, note: "the drift check is already on" });
  else if (explicit) steps.push({ mark: "=", label: rel, note: `"${explicit[0].trim()}" is set; left as is (make it "drift: true" to turn the drift check on)` });
  else if (!opts.drift) steps.push({ mark: "!", label: rel, note: "the drift check stays off (--no-drift)" });
  else {
    steps.push({
      mark: before === null ? "+" : "~",
      label: rel,
      note: `${before === null ? "new config that turns" : 'adds "drift: true", turning'} on the drift check: pull requests fail while a page falls behind its code (--no-drift skips this)`,
      run: writeFile(rel, before, withDrift(before)),
    });
  }
  return steps;
}

// ---------------------------------------------------------------- main

// io: { ask, log } stand-ins for the tests.
async function upgrade(root, argv, io = {}) {
  const ask = io.ask || init.askLine;
  const log = io.log || ((s) => console.log(s));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(err.message);
    return 2;
  }
  if (opts.help) {
    log("hypatia upgrade [--dry-run] [--yes] [--no-drift] [--public | --private]");
    return 0;
  }
  if (init.git(root, ["rev-parse", "--show-toplevel"]) === null) {
    log("hypatia upgrade works in a git repo, and this folder is not in one. cd into the repo first.");
    return 1;
  }
  const facts = readFacts(root, opts);
  if (facts.skill === null && !Object.keys(facts.texts).length) {
    log("Hypatia is not set up in this repo yet (no wiki-keeper skill, no wiki workflows). Run 'npx hypatia init' instead.");
    return 1;
  }

  const steps = plan(root, facts, opts);
  const site = facts.visibility === "public" ? "with the public website" : "no public website";
  log(`\nHypatia upgrade to ${VERSION}: ${site}, default branch ${facts.branch}${facts.custom ? `, runner kept as ${facts.custom}` : ""}.\n`);
  const width = Math.max(...steps.map((s) => s.label.length));
  for (const s of steps) log(`  ${s.mark} ${s.label.padEnd(width)}  ${s.note}`);
  log("\n  + will be added   ~ will be replaced or edited   = already current   ! not done (see why)");

  const todo = steps.filter((s) => s.run);
  if (!todo.length) {
    log("\nEverything is already current. Nothing to do.");
    return 0;
  }
  if (opts.dryRun) {
    log(`\nDry run: nothing was changed. Run it without --dry-run to do the ${todo.length} + and ~ ${todo.length === 1 ? "step" : "steps"}.`);
    return 0;
  }
  if (!opts.yes) {
    const answer = await ask(`\nMake these ${todo.length} ${todo.length === 1 ? "change" : "changes"}? [y/N] `);
    if (!init.yes(answer)) {
      log(answer === null ? "\nNo terminal to ask, so nothing was changed. Rerun with --yes to upgrade." : "\nOK, nothing was changed.");
      return 0;
    }
  }

  const done = [];
  const failed = [];
  for (const s of todo) {
    let problem;
    try {
      problem = s.run();
    } catch (err) {
      problem = err.message;
    }
    if (problem) failed.push(`${s.label}: ${problem}`);
    else done.push(s.label);
  }
  log(`\n${done.length ? `Done: ${done.join(", ")}.` : "Nothing was changed."}`);
  if (failed.length) log(`Not done:\n${failed.map((f) => "  " + f).join("\n")}`);
  log(`\nNext: run ${facts.values.HYPATIA} check, then commit the changed files together.\n`);
  return failed.length ? 1 : 0;
}

module.exports = { upgrade, upgradeNotice, outdated, compareVersions, withDrift, parseArgs };
