// Tests for `hypatia protect` (lib/protect.js): it makes the wiki-check job
// required on the default branch, adding to what is there, only after a
// yes, and prints the steps by hand when gh is missing or GitHub says no.
// GitHub is a stand-in here: no test ever runs the real gh. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const { protect, CONTEXT, RULESET } = require("../lib/protect");
const { makeRepo, write } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");
const CHECK = ".github/workflows/wiki-check.yml";
const FREE_PLAN = "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

// A stand-in for gh. state: { branch, rules: [...], classic: null | {contexts} | "denied", rulesDenied, writeErr }.
// gh.writes() lists the writes as [args, body].
function fakeGh(state = {}) {
  const calls = [];
  const gh = (args, input) => {
    calls.push([args, input === undefined ? undefined : JSON.parse(input)]);
    const url = args.find((a) => a.startsWith("repos/"));
    if (args[0] === "repo" && args[1] === "view") return { ok: true, out: JSON.stringify({ defaultBranchRef: { name: state.branch || "main" } }), err: "" };
    if (args.includes("-X")) {
      if (state.writeErr) return { ok: false, out: "", err: state.writeErr };
      return { ok: true, out: "{}", err: "" };
    }
    if (/\/rules\/branches\//.test(url)) {
      if (state.rulesDenied) return { ok: false, out: "", err: FREE_PLAN };
      return { ok: true, out: JSON.stringify(state.rules || []), err: "" };
    }
    if (/\/protection$/.test(url)) {
      if (state.classic === "denied") return { ok: false, out: "", err: FREE_PLAN };
      if (!state.classic) return { ok: false, out: "", err: "gh: Branch not protected (HTTP 404)" };
      return { ok: true, out: JSON.stringify({ required_status_checks: state.classic.contexts ? { strict: true, contexts: state.classic.contexts, checks: [] } : null, enforce_admins: { enabled: true } }), err: "" };
    }
    return { ok: false, out: "", err: `unexpected gh ${args.join(" ")}` };
  };
  gh.calls = calls;
  gh.writes = () => calls.filter(([a]) => a.includes("-X"));
  return gh;
}

async function run(root, argv, { gh = fakeGh(), answer = null } = {}) {
  const lines = [];
  const asked = [];
  const code = await protect(root, argv, {
    gh,
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    log: (s) => lines.push(s),
  });
  return { code, out: lines.join("\n"), asked };
}

// A repo with the check installed.
function repoWithCheck() {
  const repo = makeRepo({ generic: true });
  write(repo.root, CHECK, "name: Wiki check\njobs:\n  wiki-check:\n    runs-on: ubuntu-latest\n");
  return repo;
}

test("no protection yet: a new ruleset requires wiki-check on the default branch, only after a yes", async () => {
  const repo = repoWithCheck();
  try {
    const gh = fakeGh({ branch: "master" });
    const no = await run(repo.root, [], { gh, answer: "n" });
    assert.strictEqual(no.code, 0, no.out);
    assert.match(no.asked[0], /Make this change on GitHub\? \[y\/N\]/);
    assert.match(no.out, /\+ GitHub: ruleset "Hypatia wiki check"\s+new ruleset: pull requests into master need the "wiki-check" check to pass/);
    assert.match(no.out, /not on origin\/master yet\. Push it first/);
    assert.match(no.out, /OK, nothing was changed/);
    assert.deepStrictEqual(gh.writes(), []);

    const none = await run(repo.root, [], { gh, answer: null });
    assert.match(none.out, /No terminal to ask, so nothing was changed\. Rerun with --yes/);
    const dry = await run(repo.root, ["--dry-run", "--yes"], { gh });
    assert.match(dry.out, /Dry run: nothing was changed on GitHub/);
    assert.deepStrictEqual(dry.asked, []);
    assert.deepStrictEqual(gh.writes(), []);

    const yes = await run(repo.root, [], { gh, answer: "y" });
    assert.strictEqual(yes.code, 0, yes.out);
    assert.match(yes.out, /Done: pull requests into master now need the "wiki-check" check to pass/);
    const [[args, body]] = gh.writes();
    assert.deepStrictEqual(args, ["api", "-X", "POST", "repos/acme/notes-app/rulesets", "--input", "-"]);
    assert.strictEqual(body.name, RULESET);
    assert.strictEqual(body.enforcement, "active");
    assert.deepStrictEqual(body.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
    assert.deepStrictEqual(body.rules, [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CONTEXT }] } }]);
  } finally {
    repo.cleanup();
  }
});

test("classic branch protection with required checks: wiki-check is added to its list, nothing replaced", async () => {
  const repo = repoWithCheck();
  try {
    const gh = fakeGh({ classic: { contexts: ["build", "lint"] } });
    const r = await run(repo.root, ["--yes"], { gh });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.asked, []);
    assert.match(r.out, /\+ GitHub: branch protection on main\s+adds "wiki-check" to its required status checks \(now: build, lint\); everything else stays as it is/);
    assert.deepStrictEqual(gh.writes(), [[["api", "-X", "POST", "repos/acme/notes-app/branches/main/protection/required_status_checks/contexts", "--input", "-"], { contexts: ["wiki-check"] }]]);
    assert.ok(!gh.calls.some(([a]) => a.includes("PUT")), "the protection is never replaced");
  } finally {
    repo.cleanup();
  }
});

test("classic protection without status checks keeps it and adds a ruleset", async () => {
  const repo = repoWithCheck();
  try {
    const gh = fakeGh({ classic: { contexts: null } });
    const r = await run(repo.root, ["--yes"], { gh });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /the branch protection already there is left as it is/);
    assert.strictEqual(gh.writes()[0][0][3], "repos/acme/notes-app/rulesets");
  } finally {
    repo.cleanup();
  }
});

test("already required, by a ruleset or branch protection: nothing to do, nothing asked", async () => {
  const repo = repoWithCheck();
  try {
    for (const state of [
      { rules: [{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "wiki-check" }] } }] },
      { classic: { contexts: ["wiki-check"] } },
    ]) {
      const gh = fakeGh(state);
      const r = await run(repo.root, [], { gh, answer: "y" });
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /"wiki-check" is already a required check/);
      assert.deepStrictEqual(r.asked, []);
      assert.deepStrictEqual(gh.writes(), []);
    }
  } finally {
    repo.cleanup();
  }
});

test("GitHub says no (403, a private repo on a free plan): the steps by hand, exit 0", async () => {
  const repo = repoWithCheck();
  try {
    for (const state of [{ rulesDenied: true }, { classic: "denied" }, { writeErr: FREE_PLAN }]) {
      const gh = fakeGh(state);
      const r = await run(repo.root, ["--yes"], { gh });
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /HTTP 403/);
      assert.match(r.out, /To make the wiki check required by hand:/);
      assert.match(r.out, /Open https:\/\/github\.com\/acme\/notes-app\/settings\/rules and choose New ruleset > New branch ruleset/);
      assert.match(r.out, /add the check "wiki-check"/);
      assert.match(r.out, /free GitHub plan can't require checks/);
    }
  } finally {
    repo.cleanup();
  }
});

test("no check workflow: protect refuses, since a required check that never runs blocks every pull request", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const gh = fakeGh();
    const r = await run(repo.root, ["--yes"], { gh });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /no \.github\/workflows\/wiki-check\.yml/);
    assert.deepStrictEqual(gh.calls, []);
    assert.strictEqual((await run(repo.root, ["--nope"])).code, 2);
  } finally {
    repo.cleanup();
  }
});

test("hypatia protect from the CLI: gh missing, or a gh that GitHub refuses, prints the steps by hand and exits 0", () => {
  const repo = repoWithCheck();
  try {
    const missing = spawnSync(process.execPath, [CLI, "protect", "--yes"], { cwd: repo.root, env: { ...process.env, HYPATIA_GH: path.join(repo.root, "no-such-gh") }, encoding: "utf8" });
    assert.strictEqual(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /The GitHub CLI \(gh\) is not installed/);
    assert.match(missing.stdout, /To make the wiki check required by hand:/);

    if (process.platform !== "win32") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-gh-"));
      const fake = path.join(dir, "gh");
      fs.writeFileSync(
        fake,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") { console.log(JSON.stringify({ defaultBranchRef: { name: "main" } })); process.exit(0); }
console.error(${JSON.stringify(FREE_PLAN)});
process.exit(1);
`,
        { mode: 0o755 }
      );
      const denied = spawnSync(process.execPath, [CLI, "protect", "--yes"], { cwd: repo.root, env: { ...process.env, HYPATIA_GH: fake }, encoding: "utf8" });
      fs.rmSync(dir, { recursive: true, force: true });
      assert.strictEqual(denied.status, 0, denied.stderr);
      assert.match(denied.stdout, /GitHub did not let Hypatia read the rules for main/);
      assert.match(denied.stdout, /settings\/rules/);
    }

    const help = spawnSync(process.execPath, [CLI, "help", "protect"], { encoding: "utf8" });
    assert.strictEqual(help.status, 0);
    assert.match(help.stdout, /hypatia protect \[--dry-run\] \[--yes\]/);
    const typo = spawnSync(process.execPath, [CLI, "protekt"], { cwd: repo.root, encoding: "utf8" });
    assert.match(typo.stderr, /Did you mean "hypatia protect"\?/);
  } finally {
    repo.cleanup();
  }
});
