// `hypatia protect`: makes the wiki check required before anything merges
// into the default branch.
//
//   hypatia protect             show the change, ask, then make it on GitHub
//   hypatia protect --dry-run   show the change only
//   hypatia protect --yes       no question: go ahead
//
// The check is the "wiki-check" job of .github/workflows/wiki-check.yml. It
// becomes a required status check, added to what the branch already has:
// - when the branch has classic branch protection with required status
//   checks, "wiki-check" is added to that list (nothing else changes);
// - otherwise a new ruleset, "Hypatia wiki check", requires it on the
//   default branch. Other rulesets and branch protection are left alone.
// When the check is already required, nothing changes.
//
// GitHub is reached through gh (HYPATIA_GH names a stand-in, for the tests).
// When gh is missing, not signed in or not allowed (a private repo on a free
// plan cannot require checks), it prints the steps to do it by hand on
// GitHub and exits 0: the check still runs and reports, it just can't block.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { repoSlug } = require("./build-graph");
const init = require("./init");

const CONTEXT = "wiki-check";
const RULESET = "Hypatia wiki check";

// Runs gh (or HYPATIA_GH), with optional stdin, and returns { ok, out, err, missing }.
function runGh(args, input) {
  const cmd = process.env.HYPATIA_GH || "gh";
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000, windowsHide: true, input: input === undefined ? undefined : input });
  if (r.error) return { ok: false, out: "", err: r.error.code === "ENOENT" ? `${cmd} is not installed` : r.error.message, missing: r.error.code === "ENOENT" };
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function parseArgs(argv) {
  const opts = { dryRun: false, yes: false };
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option "${a}". Try --dry-run or --yes.`);
  }
  return opts;
}

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const firstLine = (s) => String(s || "").split("\n")[0];

// GitHub said no because of the plan or the person's rights, not a typo.
const notAllowed = (err) => /\b403\b|Upgrade to GitHub Pro|make this repository public|Must have admin rights|Resource not accessible/i.test(err);

// The steps to do it by hand on GitHub.
function manualSteps(slug, branch) {
  const where = slug ? `https://github.com/${slug}/settings/rules` : "the repo on GitHub: Settings > Rules > Rulesets";
  return [
    "To make the wiki check required by hand:",
    `  1. Open ${where} and choose New ruleset > New branch ruleset.`,
    `  2. Name it "${RULESET}", set Enforcement status to Active, and add the target "Include default branch"${branch ? ` (${branch})` : ""}.`,
    `  3. Tick "Require status checks to pass", add the check "${CONTEXT}", and save.`,
    "A private repo on a free GitHub plan can't require checks: the check still runs on every pull request and shows its result, it just can't block the merge.",
  ].join("\n");
}

// What the branch requires today: { classic: { contexts } | null, required, error, denied }.
function readProtection(gh, slug, branch) {
  const out = { classic: null, required: false, error: null, denied: false };
  // rules from every ruleset that applies to the branch
  const rules = gh(["api", `repos/${slug}/rules/branches/${encodeURIComponent(branch)}`]);
  if (rules.ok) {
    for (const rule of json(rules.out) || []) {
      if (rule && rule.type === "required_status_checks") {
        const checks = (rule.parameters && rule.parameters.required_status_checks) || [];
        if (checks.some((c) => c.context === CONTEXT)) out.required = true;
      }
    }
  } else if (notAllowed(rules.err)) {
    out.denied = true;
    out.error = firstLine(rules.err);
    return out;
  }
  // classic branch protection
  const classic = gh(["api", `repos/${slug}/branches/${encodeURIComponent(branch)}/protection`]);
  if (classic.ok) {
    const p = json(classic.out) || {};
    const rsc = p.required_status_checks;
    const contexts = rsc ? [...(rsc.contexts || []), ...(rsc.checks || []).map((c) => c.context)] : null;
    out.classic = { contexts };
    if (contexts && contexts.includes(CONTEXT)) out.required = true;
  } else if (/Branch not protected/i.test(classic.err)) {
    out.classic = null;
  } else if (notAllowed(classic.err)) {
    out.denied = true;
    out.error = firstLine(classic.err);
  } else if (!rules.ok) {
    out.error = firstLine(classic.err || rules.err);
  }
  return out;
}

// The change to make: { label, note, run } where run() returns null or what went wrong.
function change(gh, slug, branch, protection) {
  if (protection.classic && protection.classic.contexts) {
    return {
      label: `GitHub: branch protection on ${branch}`,
      note: `adds "${CONTEXT}" to its required status checks (${protection.classic.contexts.length ? `now: ${protection.classic.contexts.join(", ")}` : "none yet"}); everything else stays as it is`,
      run: () => gh(["api", "-X", "POST", `repos/${slug}/branches/${encodeURIComponent(branch)}/protection/required_status_checks/contexts`, "--input", "-"], JSON.stringify({ contexts: [CONTEXT] })),
    };
  }
  const body = {
    name: RULESET,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CONTEXT }] } }],
  };
  return {
    label: `GitHub: ruleset "${RULESET}"`,
    note: `new ruleset: pull requests into ${branch} need the "${CONTEXT}" check to pass before they merge${protection.classic ? " (the branch protection already there is left as it is)" : ""}`,
    run: () => gh(["api", "-X", "POST", `repos/${slug}/rulesets`, "--input", "-"], JSON.stringify(body)),
  };
}

// io: { gh, ask, log } stand-ins for the tests.
async function protect(root, argv, io = {}) {
  const gh = io.gh || runGh;
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
    log("hypatia protect [--dry-run] [--yes]");
    return 0;
  }
  if (init.git(root, ["rev-parse", "--show-toplevel"]) === null) {
    log("hypatia protect works in a git repo, and this folder is not in one. cd into the repo first.");
    return 1;
  }
  const workflow = init.CHECK_WORKFLOW[1];
  if (!fs.existsSync(path.join(root, workflow))) {
    log(`This repo has no ${workflow}, so there is no check to require yet (requiring one that never runs would block every pull request). Run 'npx hypatia upgrade' to add it, push it, then run this again.`);
    return 1;
  }
  const slug = repoSlug(root);
  const manual = (why, branch) => {
    log(`\n${why}\n\n${manualSteps(slug, branch)}\n`);
    return 0;
  };
  if (!slug) return manual("This repo has no GitHub remote, so Hypatia can't reach it.", null);

  const view = gh(["repo", "view", slug, "--json", "defaultBranchRef"]);
  if (!view.ok) {
    const why = view.missing ? "The GitHub CLI (gh) is not installed, so Hypatia can't change GitHub for you." : `Could not read ${slug} on GitHub (${firstLine(view.err) || "gh failed"}). If gh is not signed in, run 'gh auth login' and try again.`;
    return manual(why, null);
  }
  const branch = ((json(view.out) || {}).defaultBranchRef || {}).name || init.defaultBranch(root, null);
  const protection = readProtection(gh, slug, branch);
  if (protection.denied) return manual(`GitHub did not let Hypatia read the rules for ${branch} (${protection.error}). You may need admin rights, or a paid plan for a private repo.`, branch);
  if (protection.error) return manual(`Could not read the rules for ${branch} (${protection.error}).`, branch);

  log(`\nHypatia protect for ${slug}: the "${CONTEXT}" check, required before anything merges into ${branch}.\n`);
  if (protection.required) {
    log(`  = GitHub: ${branch}  "${CONTEXT}" is already a required check\n\nNothing to do.`);
    return 0;
  }
  const step = change(gh, slug, branch, protection);
  log(`  + ${step.label}  ${step.note}`);
  const pushed = init.git(root, ["cat-file", "-e", `origin/${branch}:${workflow}`]) !== null;
  if (!pushed) log(`\n  Note: ${workflow} is not on origin/${branch} yet. Push it first, or pull requests wait for a check that never runs.`);
  if (opts.dryRun) {
    log("\nDry run: nothing was changed on GitHub.");
    return 0;
  }
  if (!opts.yes) {
    const answer = await ask(`\nMake this change on GitHub? [y/N] `);
    if (!init.yes(answer)) {
      log(answer === null ? "\nNo terminal to ask, so nothing was changed. Rerun with --yes to make the change." : "\nOK, nothing was changed.");
      return 0;
    }
  }
  const r = step.run();
  if (!r.ok) {
    if (r.missing || notAllowed(r.err)) return manual(`GitHub did not allow the change (${firstLine(r.err)}).`, branch);
    log(`\nCould not make the change (${firstLine(r.err)}).\n\n${manualSteps(slug, branch)}\n`);
    return 1;
  }
  log(`\nDone: pull requests into ${branch} now need the "${CONTEXT}" check to pass. With "drift: warn" it still passes when pages fall behind; "drift: error" in docs/hypatia.yml makes that block too.\n`);
  return 0;
}

module.exports = { protect, parseArgs, manualSteps, readProtection, runGh, CONTEXT, RULESET };
