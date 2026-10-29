// `hypatia init`: sets Hypatia up in the repo you are in.
//
//   hypatia init               print the plan, ask before public changes, do it
//   hypatia init --dry-run     print the plan only; nothing changes
//   hypatia init --yes         no question: go ahead with the public parts too
//   hypatia init --public | --private     say what the repo is (else GitHub says)
//   hypatia init --runner "<command>"     how the repo runs Hypatia (pages, scripts, skill, workflow);
//                                         default: `npx hypatia`, and `npx hypatia@<version>` in the workflow
//   hypatia init --with check,mirror,ping optional workflows, in any repo (see OPTIONAL)
//
// Every repo gets:
// - docs/wiki/ with a starter hub page, when it has no wiki pages yet;
// - the wiki-keeper agent skill in .claude/skills/wiki-keeper/;
// - a "wiki" npm script that opens the wiki locally (when the repo has a
//   package.json), or the one-line command to do it.
// A public repo also gets, only after an explicit yes (prompt or --yes):
// - the GitHub Pages workflows in .github/workflows/ (wiki-site.yml builds
//   and deploys the site, wiki-refresh.yml rebuilds it when branches move)
//   and the pull request check (wiki-check.yml);
// - GitHub Pages turned on with "Source: GitHub Actions", if it is off;
// - the repo's About website set to the site's address, if it is empty.
// A private repo gets no website: its wiki opens locally.
// --with adds optional workflows to any repo, because you asked for them:
// check (the pull request check), mirror (copies the wiki to the GitHub Wiki
// tab) and ping (posts review requests and questions to Discord).
//
// It never overwrites or edits a file that is already there (the one edit is
// adding a "wiki" script to package.json when there is none), so running it
// again is safe: it says what it left alone.
//
// GitHub is reached through the GitHub CLI (gh): two reads (the repo and its
// Pages settings) and, after the yes, at most two writes. HYPATIA_GH names
// another program to run instead of gh (the tests use a stand-in).
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const { repoSlug, siteTitle } = require("./build-graph");
const templates = require("./templates");
const { CONFIG_FILES, loadConfig } = require("./team");
const privacy = require("./privacy");

const HYPATIA_ROOT = path.join(__dirname, "..");
const WIKI_DIR = "docs/wiki";
const STARTER = "start-here";
const SKILL_FILE = ".claude/skills/wiki-keeper/SKILL.md";
const SKILL_TEMPLATE = "skills/wiki-keeper/SKILL.md";
const WORKFLOWS = [
  ["templates/workflows/wiki-site.yml", ".github/workflows/wiki-site.yml", "builds the wiki website and publishes it with GitHub Pages"],
  ["templates/workflows/wiki-refresh.yml", ".github/workflows/wiki-refresh.yml", "rebuilds the website when someone pushes a branch"],
  ["templates/workflows/wiki-check.yml", ".github/workflows/wiki-check.yml", "checks the wiki on every pull request"],
];
const OPTIONAL = {
  check: ["templates/workflows/wiki-check.yml", ".github/workflows/wiki-check.yml", "checks the wiki on every pull request"],
  mirror: ["templates/workflows/wiki-mirror.yml", ".github/workflows/wiki-mirror.yml", "copies the wiki to the GitHub Wiki tab after each merge (turn on Wikis first)"],
  ping: ["templates/workflows/wiki-ping.yml", ".github/workflows/wiki-ping.yml", "posts review requests and questions to Discord (needs a webhook secret)"],
};

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const opts = { dryRun: false, yes: false, visibility: null, runner: null, with: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--public" || a === "--private") {
      if (opts.visibility && opts.visibility !== a.slice(2)) throw new Error("Use --public or --private, not both.");
      opts.visibility = a.slice(2);
    } else if (a === "--runner" || a.startsWith("--runner=")) {
      opts.runner = (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i] || "").trim();
      if (!opts.runner) throw new Error('--runner needs a command, e.g. --runner "npx --yes hypatia".');
    } else if (a === "--with" || a.startsWith("--with=")) {
      const names = (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i] || "").split(",").map((n) => n.trim()).filter(Boolean);
      const bad = names.filter((n) => !(n in OPTIONAL));
      if (!names.length || bad.length) throw new Error(`--with takes ${Object.keys(OPTIONAL).join(", ")} (comma separated)${bad.length ? `, not "${bad.join(", ")}"` : ""}.`);
      opts.with.push(...names.filter((n) => !opts.with.includes(n)));
    } else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option "${a}". Try --dry-run, --yes, --public, --private, --runner "<command>" or --with check,mirror,ping.`);
  }
  return opts;
}

// ---------------------------------------------------------------- facts

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Runs gh (or HYPATIA_GH) and returns { ok, out, err }.
function runGh(args) {
  const cmd = process.env.HYPATIA_GH || "gh";
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000, windowsHide: true });
  if (r.error) return { ok: false, out: "", err: r.error.code === "ENOENT" ? `${cmd} is not installed` : r.error.message };
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// How this repo runs Hypatia, from Hypatia's own package.json:
// - cli: what people and agents type, `npx hypatia` (in the pages, the skill,
//   the "wiki" script and the Next steps, which are committed and shared);
// - runner: what the Pages workflow runs, pinned to this version so the
//   website keeps building the same way until someone changes it.
function defaultRunner() {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(HYPATIA_ROOT, "package.json"), "utf8"));
  return { cli: `npx ${name}`, command: `npx ${name}@${version}`, local: false };
}

// The version of Hypatia that is running, stamped into the files it installs.
const VERSION = JSON.parse(fs.readFileSync(path.join(HYPATIA_ROOT, "package.json"), "utf8")).version;

// The values the skill and workflow templates are filled with. HYPATIA is
// the command people type; the workflows get the pinned runner instead.
function templateValues(root, { slug, branch, cli }) {
  return {
    REPO_SLUG: slug || "<owner>/<repo>",
    DEFAULT_BRANCH: branch,
    WIKI_DIR,
    CONFIG_FILE: CONFIG_FILES.find((f) => fs.existsSync(path.join(root, f))) || CONFIG_FILES[0],
    HYPATIA: cli,
  };
}

// A runner GitHub Actions cannot use: one that names a folder on this computer.
const isLocalRunner = (command) => /(^|\s)("?)(\/|[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])/.test(command.replace(/^npx\s+(--yes\s+|-y\s+)?/, " "));

// The repo on GitHub, from two gh reads: { visibility, branch, homepage,
// pages: { enabled, buildType, url } | null, error }.
function readGithub(slug, gh) {
  const view = gh(["repo", "view", slug, "--json", "visibility,defaultBranchRef,homepageUrl,url"]);
  if (!view.ok) return { error: view.err.split("\n")[0] || "gh repo view failed" };
  let repo;
  try {
    repo = JSON.parse(view.out);
  } catch {
    return { error: "gh repo view gave something that is not JSON" };
  }
  const out = {
    visibility: String(repo.visibility || "").toLowerCase() || null,
    branch: (repo.defaultBranchRef && repo.defaultBranchRef.name) || null,
    homepage: repo.homepageUrl || "",
    pages: null,
  };
  if (out.visibility === "public") {
    const pages = gh(["api", `repos/${slug}/pages`]);
    if (pages.ok) {
      try {
        const p = JSON.parse(pages.out);
        out.pages = { enabled: true, buildType: p.build_type || "legacy", url: p.html_url || null };
      } catch {
        out.pages = null;
      }
    } else if (/404|Not Found/i.test(pages.err)) out.pages = { enabled: false, buildType: null, url: null };
  }
  return out;
}

// The address GitHub Pages gives a repo: owner.github.io/name/.
function pagesUrl(slug) {
  const [owner, name] = slug.split("/");
  const host = `${owner.toLowerCase()}.github.io`;
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`;
}

// The branch new work starts from.
function defaultBranch(root, fromGithub) {
  if (fromGithub) return fromGithub;
  const head = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^refs\/remotes\/origin\//, "");
  return git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "main";
}

// ---------------------------------------------------------------- files

// Markdown files in the wiki folder, split into wiki pages (front matter)
// and other notes.
function wikiFiles(root) {
  const dir = path.join(root, WIKI_DIR);
  const pages = [];
  const notes = [];
  if (!fs.existsSync(dir)) return { exists: false, pages, notes };
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".md") || fs.statSync(path.join(dir, name)).isDirectory()) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8").replace(/^﻿/, "");
    (text.startsWith("---") ? pages : notes).push(name);
  }
  return { exists: true, pages, notes };
}

function starterPage({ title, open, runner, notes }) {
  const older = notes.length
    ? `\n## Older notes\n\nThese Markdown files were in this folder before the wiki. They open on GitHub. To make one a wiki page, rename it to lowercase words joined by '-' and give it front matter as above.\n\n${notes
        .map((n) => `- [${n.replace(/\.md$/, "").replace(/[-_]+/g, " ")}](${n})`)
        .join("\n")}\n`
    : "";
  return `---
title: Start here
parent: home
---

# Start here

This is the first page of the ${title} wiki. Each page explains one part of the code in plain English: what it does for the project, what it uses, and how it breaks. The map shows how the parts connect and who is working on each one.

## Open the wiki

From the repo, run \`${open}\`. It opens the wiki in your browser and reloads it whenever a page changes.

## Add a page

1. Make \`${WIKI_DIR}/<name>.md\` (lowercase words joined by '-') that starts like this:

   \`\`\`
   ---
   title: Search
   parent: start-here        # the hub it belongs under; a new hub uses "home"
   code: [src/search/**]     # optional: the code this page is about
   ---
   \`\`\`

2. Link to it from its hub page, and link pages that work together.
3. Run \`${runner} check\` until it says the check passed.

Or ask Claude to write the pages: the wiki-keeper skill in this repo tells it how.

## Privacy

Pages describe how the code works, never real records, user names, emails or keys. Use made-up values such as \`user@example.com\`. The check stops the website build if a page looks like it holds personal data or a key. A page with \`private: true\` in its front matter shows only on your own computer, never on the website.
${older}`;
}

// package.json with a "wiki" script added, keeping its indent and final newline.
function withWikiScript(text, command) {
  const pkg = JSON.parse(text);
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("not a JSON object");
  if (pkg.scripts && typeof pkg.scripts !== "object") throw new Error('"scripts" is not an object');
  pkg.scripts = { ...(pkg.scripts || {}), wiki: command };
  const indent = (/\n([ \t]+)"/.exec(text) || [null, "  "])[1];
  return JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : "");
}

// ---------------------------------------------------------------- plan

// Every step: { mark, label, note, public, run }. mark "+" will happen, "="
// already done, "!" cannot happen here (note says why). public steps wait
// for the yes. run() does it and returns what to say when it fails, or null.
function plan(root, facts) {
  const steps = [];
  const add = (step) => steps.push({ public: false, run: null, ...step });
  const file = (rel) => path.join(root, rel);
  const createFile = (rel, text) => () => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), text, { flag: "wx" }); // never overwrites
    return null;
  };

  // the wiki folder and its starter page
  const wiki = wikiFiles(root);
  const starterRel = `${WIKI_DIR}/${STARTER}.md`;
  if (wiki.pages.length) {
    add({ mark: "=", label: `${WIKI_DIR}/`, note: `already has ${wiki.pages.length} wiki ${wiki.pages.length === 1 ? "page" : "pages"}; left as is` });
  } else if (fs.existsSync(file(starterRel))) {
    add({ mark: "=", label: starterRel, note: "already there; left as is" });
  } else {
    const text = starterPage({ title: facts.title, open: facts.open, runner: facts.cli, notes: wiki.notes });
    const older = wiki.notes.length ? ` (links the ${wiki.notes.length} Markdown ${wiki.notes.length === 1 ? "file" : "files"} already there)` : "";
    add({ mark: "+", label: starterRel, note: `starter hub page${older}`, run: createFile(starterRel, text) });
  }

  // the agent skill
  const skill = templates.renderStamped(SKILL_TEMPLATE, facts.values, VERSION);
  if (fs.existsSync(file(SKILL_FILE))) {
    const same = fs.readFileSync(file(SKILL_FILE), "utf8") === skill;
    add({ mark: "=", label: SKILL_FILE, note: same ? "already there; left as is" : "already there and different from this version; left as is (hypatia upgrade updates it)" });
  } else add({ mark: "+", label: SKILL_FILE, note: "wiki-keeper skill, so Claude keeps the pages true to the code", run: createFile(SKILL_FILE, skill) });

  // how to open it locally
  const pkgFile = file("package.json");
  if (fs.existsSync(pkgFile)) {
    let pkg = null;
    let problem = null;
    const text = fs.readFileSync(pkgFile, "utf8");
    try {
      pkg = JSON.parse(text);
      withWikiScript(text, facts.serve);
    } catch (err) {
      problem = err.message;
    }
    if (problem) add({ mark: "!", label: "package.json", note: `could not add the "wiki" script (${problem}); open the wiki with: ${facts.serve}` });
    else if (pkg.scripts && pkg.scripts.wiki !== undefined) {
      add({ mark: "=", label: "package.json", note: pkg.scripts.wiki === facts.serve ? 'already has the "wiki" script' : 'already has a "wiki" script of its own; left as is' });
    } else {
      add({
        mark: "+",
        label: "package.json",
        note: `adds the script "wiki": ${facts.serve}`,
        run: () => {
          const now = fs.readFileSync(pkgFile, "utf8");
          if (now !== text) return "package.json changed while init ran; left as is";
          fs.writeFileSync(pkgFile, withWikiScript(now, facts.serve));
          return null;
        },
      });
    }
  }

  // optional workflows asked for with --with (wiki-check is also part of a public repo's set)
  for (const name of facts.with || []) {
    const [src, rel, what] = OPTIONAL[name];
    if (facts.visibility === "public" && WORKFLOWS.some(([, r]) => r === rel)) continue;
    if (facts.runnerLocal) add({ mark: "!", label: rel, note: "not installed: GitHub can't run Hypatia from a folder on this computer" });
    else if (fs.existsSync(file(rel))) add({ mark: "=", label: rel, note: "already there; left as is" });
    else add({ mark: "+", label: rel, note: what, run: createFile(rel, templates.renderStamped(src, { ...facts.values, HYPATIA: facts.runner }, VERSION)) });
  }

  if (facts.visibility !== "public") return steps;

  // the public website
  if (facts.runnerLocal) {
    const why = "GitHub can't run Hypatia from a folder on this computer";
    for (const [, rel] of WORKFLOWS) add({ mark: "!", label: rel, note: `not installed: ${why}`, public: true });
    add({ mark: "!", label: "GitHub: Pages and the About website", note: `not changed: ${why}`, public: true });
    return steps;
  }
  for (const [src, rel, what] of WORKFLOWS) {
    if (fs.existsSync(file(rel))) add({ mark: "=", label: rel, note: "already there; left as is", public: true });
    else add({ mark: "+", label: rel, note: what, public: true, run: createFile(rel, templates.renderStamped(src, { ...facts.values, HYPATIA: facts.runner }, VERSION)) });
  }
  const gh = facts.gh;
  const pages = facts.github.pages;
  if (!facts.slug || facts.github.error) {
    add({ mark: "!", label: "GitHub settings", note: "not changed: could not read the repo on GitHub", public: true });
    return steps;
  }
  if (!pages) {
    add({ mark: "!", label: "GitHub: Pages", note: "not changed: could not read the Pages settings (you may need admin rights)", public: true });
  } else if (!pages.enabled) {
    add({
      mark: "+",
      label: "GitHub: Pages",
      note: "turn on GitHub Pages with Source: GitHub Actions",
      public: true,
      run: () => {
        const r = gh(["api", "-X", "POST", `repos/${facts.slug}/pages`, "-f", "build_type=workflow"]);
        if (!r.ok) return `could not turn on Pages (${r.err.split("\n")[0]})`;
        try {
          const url = JSON.parse(r.out).html_url;
          if (url) facts.siteUrl = url;
        } catch {
          // keep the address worked out from the repo's name
        }
        return null;
      },
    });
  } else if (pages.buildType !== "workflow") {
    add({ mark: "!", label: "GitHub: Pages", note: "already on, publishing from a branch; switch Source to GitHub Actions yourself if this site should replace it", public: true });
  } else add({ mark: "=", label: "GitHub: Pages", note: "already on with Source: GitHub Actions", public: true });

  const home = facts.github.homepage;
  const same = (a, b) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  if (home && same(home, facts.siteUrl)) add({ mark: "=", label: "GitHub: About website", note: `already ${home}`, public: true });
  else if (home) add({ mark: "!", label: "GitHub: About website", note: `left as ${home} (not replaced); the wiki will be at ${facts.siteUrl}`, public: true });
  else {
    add({
      mark: "+",
      label: "GitHub: About website",
      note: `set to ${facts.siteUrl}`,
      public: true,
      run: () => {
        const r = gh(["api", "-X", "PATCH", `repos/${facts.slug}`, "-f", `homepage=${facts.siteUrl}`]);
        return r.ok ? null : `could not set the website (${r.err.split("\n")[0]})`;
      },
    });
  }
  return steps;
}

// ---------------------------------------------------------------- prompt

// One line typed in the terminal, or null when there is no terminal to ask.
function askLine(question, input = process.stdin, output = process.stdout) {
  if (!input.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    // resolve before close: close() fires "close" at once, which would
    // otherwise settle the answer as null (no terminal)
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
    rl.on("close", () => resolve(null));
  });
}

const yes = (answer) => /^\s*y(es)?\s*$/i.test(answer || "");

// ---------------------------------------------------------------- main

// io: { gh, ask, log } stand-ins for the tests.
async function init(root, argv, io = {}) {
  const gh = io.gh || runGh;
  const ask = io.ask || askLine;
  const log = io.log || ((s) => console.log(s));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(err.message);
    return 2;
  }
  if (opts.help) {
    log('hypatia init [--dry-run] [--yes] [--public | --private] [--runner "<command>"] [--with check,mirror,ping]');
    return 0;
  }
  if (git(root, ["rev-parse", "--show-toplevel"]) === null) {
    log("hypatia init sets Hypatia up in a git repo, and this folder is not in one. Run `git init` first, or cd into the repo.");
    return 1;
  }

  // what the repo is
  const slug = repoSlug(root);
  const github = slug ? readGithub(slug, gh) : { error: "no GitHub remote" };
  let visibility = opts.visibility || github.visibility || null;
  let visibilityFrom = opts.visibility ? "you said so" : github.visibility ? "GitHub says so" : null;
  if (!visibility && slug) {
    const answer = await ask(`Could not ask GitHub whether ${slug} is public (${github.error}). Is it public? [y/N] `);
    if (answer !== null) {
      visibility = yes(answer) ? "public" : "private";
      visibilityFrom = "you said so";
    }
  }
  if (!visibility) {
    visibility = "private";
    visibilityFrom = slug ? "GitHub could not be read, so it stays local; use --public to change that" : "no GitHub remote";
  }
  const branch = defaultBranch(root, github.branch);
  // --runner names one command for everything; the default splits it (see defaultRunner)
  const runner = opts.runner ? { cli: opts.runner, command: opts.runner, local: isLocalRunner(opts.runner) } : defaultRunner();
  const pkg = fs.existsSync(path.join(root, "package.json"));
  const serveCmd = `${runner.cli} serve`;
  const facts = {
    slug,
    github,
    gh,
    visibility,
    branch,
    cli: runner.cli,
    runner: runner.command,
    runnerLocal: runner.local,
    with: opts.with,
    serve: serveCmd,
    open: pkg ? "npm run wiki" : serveCmd,
    title: siteTitle(root, { repo: slug }),
    siteUrl: slug ? (github.pages && github.pages.url) || pagesUrl(slug) : null,
    values: templateValues(root, { slug, branch, cli: runner.cli }), // the workflows get runner.command (see plan)
  };
  const steps = plan(root, facts);

  log(`\nHypatia init for ${slug || facts.title}: ${visibility} (${visibilityFrom}), default branch ${branch}.\n`);
  const width = Math.max(...steps.map((s) => s.label.length));
  for (const s of steps) log(`  ${s.mark} ${s.label.padEnd(width)}  ${s.note}`);
  log("\n  + will be done   = already there, left alone   ! not done here (see why)");

  const todo = steps.filter((s) => s.mark === "+");
  const publicTodo = todo.filter((s) => s.public);
  if (publicTodo.length) log("  The .github and GitHub steps make the wiki public, so init asks before doing them.");
  if (visibility === "public") {
    // what the website build would refuse today, so it is no surprise later
    const pages = ["README.md", ...wikiFiles(root).pages.map((n) => `${WIKI_DIR}/${n}`)].filter((f) => fs.existsSync(path.join(root, f)));
    const hits = privacy.scanFiles(root, pages, { allow: loadConfig(root).allow });
    if (hits.length) {
      log(`
  Privacy guard: the website build will refuse to publish until these are gone (or allowed in docs/hypatia.yml):`);
      for (const line of privacy.describeHits(hits)) log(`    ${line}`);
    }
  }
  if (opts.dryRun) {
    log(`\nDry run: nothing was changed. ${todo.length ? `Run it without --dry-run to do the ${todo.length} + ${todo.length === 1 ? "step" : "steps"}.` : "Nothing to do."}`);
    return 0;
  }

  let publicOk = true;
  if (publicTodo.length && !opts.yes) {
    const answer = await ask(`\nSet up the public website (the + steps for .github/workflows and GitHub above)? [y/N] `);
    publicOk = yes(answer);
    if (!publicOk) log(answer === null ? "\nNo terminal to ask, so the public website is not set up. Rerun with --yes to set it up." : "\nOK, the public website is not set up.");
  }

  const done = [];
  const failed = [];
  for (const s of todo) {
    if (s.public && !publicOk) continue;
    let problem;
    try {
      problem = s.run();
    } catch (err) {
      problem = err.code === "EEXIST" ? "appeared while init ran; left as is" : err.message;
    }
    if (problem) failed.push(`${s.label}: ${problem}`);
    else done.push(s.label);
  }

  // what happened and what to do next
  log(`\n${done.length ? `Done: ${done.join(", ")}.` : "Nothing new to set up: everything was already there."}`);
  if (failed.length) log(`Not done:\n${failed.map((f) => "  " + f).join("\n")}`);
  const next = [];
  next.push(`Ask your coding agent to write the pages: "Read ${SKILL_FILE} and write the first wiki pages for this repo, then run ${runner.cli} check."`);
  next.push(`Open the wiki on your computer: ${facts.open}`);
  if (runner.local) next.push("That command names a folder on this computer, so it works here only, not for teammates or GitHub.");
  const readme = fs.readdirSync(root).find((n) => /^readme\.md$/i.test(n));
  if (readme && done.includes(`${WIKI_DIR}/${STARTER}.md`) && !fs.readFileSync(path.join(root, readme), "utf8").includes(`${WIKI_DIR}/${STARTER}.md`)) {
    next.push(`Link the wiki from ${readme}, e.g. [Start here](${WIKI_DIR}/${STARTER}.md), so readers find it (the check warns until then).`);
  }
  if (visibility === "public" && runner.local) {
    next.push(`No website yet: GitHub needs a Hypatia it can download. Once there is one, rerun with --runner "npx <package>@<version>".`);
  } else if (visibility === "public" && publicOk && publicTodo.length + steps.filter((s) => s.public && s.mark === "=").length) {
    const pagesFailed = failed.some((f) => f.startsWith("GitHub: Pages")) || steps.some((s) => s.label === "GitHub: Pages" && s.mark === "!");
    next.push(`Commit and push the new files to ${branch}. GitHub then builds the website at ${facts.siteUrl}`);
    if (pagesFailed) next.push("One-time step on GitHub: Settings > Pages > Source: GitHub Actions.");
  } else if (visibility === "public") {
    next.push("Rerun hypatia init and say yes to set up the website.");
  } else {
    next.push("No website: this repo is private, so the wiki opens only on your computer, with the command above.");
  }
  log(`\nNext:\n${next.map((n) => "  - " + n).join("\n")}\n`);
  return failed.length ? 1 : 0;
}

module.exports = { init, parseArgs, plan, pagesUrl, isLocalRunner, withWikiScript, starterPage, wikiFiles, defaultRunner, templateValues, defaultBranch, askLine, yes, git, VERSION, WIKI_DIR, SKILL_FILE, SKILL_TEMPLATE, WORKFLOWS, OPTIONAL };
