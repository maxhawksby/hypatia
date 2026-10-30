// Tests for `hypatia upgrade` (lib/upgrade.js) and the notice `hypatia check`
// prints when a repo's Hypatia files are from an older version. An "old
// install" here is what 0.2.1 wrote: a skill with no stamp and workflows
// pinned to npx hypatia@0.2.1. Nothing here reaches GitHub. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const { upgrade, upgradeNotice, compareVersions, withDrift } = require("../lib/upgrade");
const { init, VERSION, templateValues } = require("../lib/init");
const templates = require("../lib/templates");
const { loadConfig } = require("../lib/team");
const { makeRepo, write } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");
const SKILL = ".claude/skills/wiki-keeper/SKILL.md";
const SITE = ".github/workflows/wiki-site.yml";
const REFRESH = ".github/workflows/wiki-refresh.yml";
const CHECK = ".github/workflows/wiki-check.yml";
const MIRROR = ".github/workflows/wiki-mirror.yml";
const PING = ".github/workflows/wiki-ping.yml";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

// What 0.2.1 installed: the skill without a stamp (and without the drift
// sentence it did not have yet), and, for a public repo, the two website
// workflows pinned to npx hypatia@0.2.1.
function oldInstall(root, { cli = "npx hypatia", runner = "npx hypatia@0.2.1", website = true } = {}) {
  const values = templateValues(root, { slug: "acme/notes-app", branch: "master", cli });
  write(root, SKILL, templates.render("skills/wiki-keeper/SKILL.md", values).replace(/ When the repo turns on the drift check[^\n]*/, ""));
  if (!website) return;
  write(root, SITE, templates.render("templates/workflows/wiki-site.yml", { ...values, HYPATIA: runner }));
  write(root, REFRESH, templates.render("templates/workflows/wiki-refresh.yml", { ...values, HYPATIA: runner }));
}

// Runs upgrade with stand-ins; returns { code, out, asked }.
async function run(root, argv, { answer = null } = {}) {
  const lines = [];
  const asked = [];
  const code = await upgrade(root, argv, {
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

test("an old install moves to this version: skill stamped, pins moved, the pull request check and drift added", async () => {
  const repo = makeRepo({ generic: true });
  try {
    oldInstall(repo.root);
    assert.match(upgradeNotice(repo.root), new RegExp(`setup is from 0\\.2\\.1 \\(now ${esc(VERSION)}\\)\\. Run 'npx hypatia upgrade'`));

    const r = await run(repo.root, ["--yes"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.asked, [], "--yes never asks");
    assert.match(r.out, /with the public website, default branch master\./);
    assert.match(r.out, new RegExp(`~ ${esc(SKILL)}\\s+updates the agent skill, from an older version to ${esc(VERSION)}; .*any edits made here will be lost`));
    assert.match(r.out, new RegExp(`~ ${esc(SITE)}\\s+updates the workflow, from 0\\.2\\.1 to ${esc(VERSION)}`));
    assert.match(r.out, new RegExp(`\\+ ${esc(CHECK)}\\s+checks the wiki on every pull request`));
    assert.match(r.out, /\+ docs\/hypatia\.yml\s+new config that turns on the drift check/);

    const skill = read(repo.root, SKILL);
    assert.deepStrictEqual(templates.readStamp(skill), { version: VERSION, edited: false });
    assert.match(skill, /^---\nname: wiki-keeper\n[\s\S]*?\n---\n\n<!-- Made by Hypatia /, "the stamp comes after the front matter");
    assert.match(skill, /`npx hypatia serve`/);
    assert.match(skill, /drift: true/);
    for (const rel of [SITE, CHECK]) {
      const text = read(repo.root, rel);
      assert.match(text, new RegExp(`run: npx hypatia@${esc(VERSION)} (build|check)`), rel);
      assert.doesNotMatch(text, /hypatia@0\.2\.1/, rel);
      assert.match(text, /branches: \[master\]/, rel);
      assert.strictEqual(templates.readStamp(text).version, VERSION, rel);
    }
    assert.match(read(repo.root, REFRESH), /branches-ignore: \[master\]/);
    assert.ok(!exists(repo.root, MIRROR) && !exists(repo.root, PING), "mirror and ping are never added");
    assert.strictEqual(loadConfig(repo.root).drift, "error");
    assert.strictEqual(upgradeNotice(repo.root), null, "no notice once upgraded");

    // a second run finds everything current
    const before = snapshot(repo.root);
    const again = await run(repo.root, []);
    assert.strictEqual(again.code, 0, again.out);
    assert.deepStrictEqual(again.asked, [], "nothing to do, so nothing to ask");
    assert.deepStrictEqual(snapshot(repo.root), before);
    for (const rel of [SKILL, SITE, REFRESH, CHECK]) assert.match(again.out, new RegExp(`= ${esc(rel)}\\s+already current`), rel);
    assert.match(again.out, /= docs\/hypatia\.yml\s+the drift check is already on/);
    assert.match(again.out, /Everything is already current/);
  } finally {
    repo.cleanup();
  }
});

test("a custom runner is kept in every workflow and the skill, and goes into the new check", async () => {
  const repo = makeRepo({ generic: true });
  const runner = "npx --yes github:acme/hypatia-fork#v1";
  try {
    oldInstall(repo.root, { cli: runner, runner });
    const r = await run(repo.root, ["--yes", "--no-drift"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`runner kept as ${esc(runner)}`));
    assert.match(read(repo.root, SITE), new RegExp(`run: ${esc(runner)} build --out _site`));
    assert.match(read(repo.root, CHECK), new RegExp(`run: ${esc(runner)} check`));
    assert.match(read(repo.root, SKILL), new RegExp(`\`${esc(runner)} serve\``));
    assert.doesNotMatch(read(repo.root, SITE), /npx hypatia@/);
    assert.match(r.out, /! docs\/hypatia\.yml\s+the drift check stays off \(--no-drift\)/);
  } finally {
    repo.cleanup();
  }
});

test("a dry run, a no, and no terminal all leave every file as it was", async () => {
  const repo = makeRepo({ generic: true });
  try {
    oldInstall(repo.root);
    const before = snapshot(repo.root);

    const dry = await run(repo.root, ["--dry-run"]);
    assert.strictEqual(dry.code, 0, dry.out);
    assert.match(dry.out, /Dry run: nothing was changed\. Run it without --dry-run to do the 5 \+ and ~ steps\./);
    assert.deepStrictEqual(dry.asked, []);

    const no = await run(repo.root, [], { answer: "n" });
    assert.strictEqual(no.asked.length, 1);
    assert.match(no.out, /OK, nothing was changed\./);

    const silent = await run(repo.root, [], { answer: null });
    assert.match(silent.out, /No terminal to ask, so nothing was changed\. Rerun with --yes/);

    assert.deepStrictEqual(snapshot(repo.root), before);

    const cli = spawnSync(process.execPath, [CLI, "upgrade"], { cwd: repo.root, encoding: "utf8", input: "" });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /No terminal to ask, so nothing was changed/);
    assert.deepStrictEqual(snapshot(repo.root), before, "run from the CLI with no terminal, it changes nothing");

    const yes = await run(repo.root, [], { answer: "y" });
    assert.strictEqual(yes.code, 0, yes.out);
    assert.match(yes.out, /Done: /);
  } finally {
    repo.cleanup();
  }
});

test("the drift switch edits one line of an existing config, and an explicit no is respected", async () => {
  const repo = makeRepo({ generic: true });
  try {
    oldInstall(repo.root, { website: false });
    const config = "title: Acme Notes\n# who is who\npeople:\n  - github: ana-gh\n    focus: Search   # this quarter\nallow: [help@example.com]";
    write(repo.root, "docs/hypatia.yml", config);
    const r = await run(repo.root, ["--yes"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /~ docs\/hypatia\.yml\s+adds "drift: true"/);
    assert.strictEqual(read(repo.root, "docs/hypatia.yml"), `${config}\ndrift: true\n`, "every other line is kept as it was");
    const loaded = loadConfig(repo.root);
    assert.strictEqual(loaded.drift, "error");
    assert.strictEqual(loaded.people[0].focus, "Search");

    write(repo.root, "docs/hypatia.yml", "title: Acme Notes\ndrift: off\n");
    const off = await run(repo.root, ["--yes"]);
    assert.match(off.out, /= docs\/hypatia\.yml\s+"drift: off" is set; left as is/);
    assert.strictEqual(read(repo.root, "docs/hypatia.yml"), "title: Acme Notes\ndrift: off\n");

    assert.strictEqual(withDrift("title: A\ndrift:\n"), "title: A\ndrift: true\n", "an empty drift: line is filled in, not repeated");
  } finally {
    repo.cleanup();
  }
});

test("the older docs/team.yml gets the switch when that is the repo's config", async () => {
  const repo = makeRepo();
  try {
    oldInstall(repo.root, { website: false });
    const before = read(repo.root, "docs/team.yml");
    const r = await run(repo.root, ["--yes"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(read(repo.root, "docs/team.yml"), `${before}${before.endsWith("\n") ? "" : "\n"}drift: true\n`);
    assert.ok(!exists(repo.root, "docs/hypatia.yml"), "no second config file");
  } finally {
    repo.cleanup();
  }
});

test("a repo without the website gets no workflows, and --private keeps the check out of one that has it", async () => {
  const repo = makeRepo({ generic: true });
  try {
    oldInstall(repo.root, { website: false });
    const r = await run(repo.root, ["--yes"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /no public website/);
    assert.ok(!exists(repo.root, ".github"), "nothing added under .github");

    oldInstall(repo.root);
    const p = await run(repo.root, ["--yes", "--private"]);
    assert.strictEqual(p.code, 0, p.out);
    assert.ok(!exists(repo.root, CHECK));
    assert.match(read(repo.root, SITE), new RegExp(`npx hypatia@${esc(VERSION)}`), "workflows already there are still refreshed");
  } finally {
    repo.cleanup();
  }
});

test("mirror and ping are refreshed when present, and a hand edit is named before it is replaced", async () => {
  const repo = makeRepo({ generic: true });
  try {
    oldInstall(repo.root, { website: false });
    const values = templateValues(repo.root, { slug: "acme/notes-app", branch: "master", cli: "npx hypatia" });
    write(repo.root, MIRROR, templates.render("templates/workflows/wiki-mirror.yml", { ...values, HYPATIA: "npx hypatia@0.2.9" }));
    write(repo.root, PING, templates.renderStamped("templates/workflows/wiki-ping.yml", { ...values, HYPATIA: `npx hypatia@${VERSION}` }, VERSION));
    write(repo.root, PING, read(repo.root, PING).replace("name:", "# our own note\nname:"));
    const r = await run(repo.root, ["--dry-run"]);
    assert.match(r.out, new RegExp(`~ ${esc(MIRROR)}\\s+updates the workflow, from 0\\.2\\.9 to`));
    assert.match(r.out, new RegExp(`~ ${esc(PING)}\\s+updates the workflow, from ${esc(VERSION)} to ${esc(VERSION)}; it was edited by hand since Hypatia ${esc(VERSION)} wrote it, and those edits will be lost`));
    assert.ok(!exists(repo.root, CHECK), "a repo without the website gets no check");
  } finally {
    repo.cleanup();
  }
});

test("files this version's init wrote are current: upgrade only offers the drift switch", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const gh = () => ({ ok: true, out: JSON.stringify({ visibility: "PUBLIC", defaultBranchRef: { name: "master" } }), err: "" });
    await init(repo.root, ["--yes", "--with", "mirror"], { gh, ask: async () => null, log: () => {} });
    assert.strictEqual(templates.readStamp(read(repo.root, SKILL)).version, VERSION);
    assert.strictEqual(upgradeNotice(repo.root), null);
    const r = await run(repo.root, ["--dry-run"]);
    for (const rel of [SKILL, SITE, REFRESH, CHECK, MIRROR]) assert.match(r.out, new RegExp(`= ${esc(rel)}\\s+already current`), rel);
    assert.match(r.out, /\+ docs\/hypatia\.yml/);
    assert.match(r.out, /to do the 1 \+ and ~ step\./);
  } finally {
    repo.cleanup();
  }
});

test("upgrade in a repo Hypatia never set up says to run init, and bad options are refused", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const r = await run(repo.root, ["--yes"]);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /Hypatia is not set up in this repo yet.*hypatia init/);
    const bad = await run(repo.root, ["--force"]);
    assert.strictEqual(bad.code, 2);
    assert.match(bad.out, /Unknown option "--force"/);
  } finally {
    repo.cleanup();
  }
});

test("check prints the upgrade notice for an old install only, and it never fails the check", () => {
  const repo = makeRepo({ generic: true });
  const check = () => spawnSync(process.execPath, [CLI, "check"], { cwd: repo.root, encoding: "utf8" });
  try {
    const none = check();
    assert.strictEqual(none.status, 0, none.stderr);
    assert.doesNotMatch(none.stderr, /upgrade/, "never set up with init: no notice");
    assert.strictEqual(upgradeNotice(repo.root), null);

    oldInstall(repo.root);
    const old = check();
    assert.strictEqual(old.status, 0, old.stderr);
    assert.match(old.stderr, new RegExp(`hypatia: this project's Hypatia setup is from 0\\.2\\.1 \\(now ${esc(VERSION)}\\)\\. Run 'npx hypatia upgrade' to update the agent skill and workflows\\.`));
    assert.match(old.stdout, /Wiki check passed/);

    // a skill with no stamp and no website: the version is unknown, but older
    fs.rmSync(path.join(repo.root, ".github"), { recursive: true });
    assert.match(upgradeNotice(repo.root), /setup is from an older Hypatia \(now /);

    // a skill stamped by a newer Hypatia than the one running: no notice
    write(repo.root, SKILL, templates.stamp("---\nname: wiki-keeper\n---\n\nhypatia\n", SKILL, "99.0.0"));
    assert.strictEqual(upgradeNotice(repo.root), null);
    // a workflow with its own runner and no stamp says nothing about its age
    write(repo.root, SKILL, templates.stamp("---\nname: wiki-keeper\n---\n\nhypatia\n", SKILL, VERSION));
    write(repo.root, SITE, "on: push\njobs:\n  b:\n    steps:\n      - run: node bin/hypatia.js build --out _site\n");
    assert.strictEqual(upgradeNotice(repo.root), null);
    // a skill someone wrote that never mentions Hypatia is not Hypatia's
    write(repo.root, SKILL, "---\nname: wiki-keeper\n---\n\nmy own skill\n");
    assert.strictEqual(upgradeNotice(repo.root), null);
  } finally {
    repo.cleanup();
  }
});

test("helpers: versions compare by number, and a stamp survives only an unchanged file", () => {
  assert.strictEqual(compareVersions("0.2.10", "0.2.9"), 1);
  assert.strictEqual(compareVersions("0.2.1", "0.3.0"), -1);
  assert.strictEqual(compareVersions("1.0.0", "1.0.0"), 0);
  const md = "---\nname: x\n---\n\n# X\n";
  const stamped = templates.stamp(md, "a/SKILL.md", "1.2.3");
  assert.strictEqual(templates.unstamp(stamped), md);
  assert.deepStrictEqual(templates.readStamp(stamped), { version: "1.2.3", edited: false });
  assert.strictEqual(templates.readStamp(stamped.replace("# X", "# Y")).edited, true);
  const yml = "name: Wiki\non: push\n";
  const y = templates.stamp(yml, "w.yml", "1.2.3");
  assert.match(y, /^# Made by Hypatia 1\.2\.3 \(#[0-9a-f]{8}\)\./);
  assert.strictEqual(templates.unstamp(y), yml);
  assert.strictEqual(templates.readStamp(yml), null);
});
