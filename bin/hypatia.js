#!/usr/bin/env node
// Hypatia: a graph-style team wiki for any git repo.
//
//   hypatia serve [--port <n>] [--no-open]   open this repo's wiki locally, with live reload
//   hypatia build [--out <folder>]           write the site and its data to a folder (default _site)
//   hypatia check                            check the pages (links, parents) without writing anything
//
// Run it from anywhere inside the repo; it works on the repo's top folder.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildGraph, describe, WikiError } = require("../lib/build-graph");
const { serve, graphScript, SITE } = require("../lib/serve");

const HELP = `Hypatia - a graph-style team wiki for any git repo.

Usage, from inside a repo:
  hypatia serve [--port <number>] [--no-open]
      Builds the wiki for this repo, serves it at http://localhost:4410/,
      opens your browser and reloads it when README.md, docs/wiki/ or
      docs/hypatia.yml change. Stop it with Ctrl+C.
  hypatia build [--out <folder>]
      Writes the site and its data (graph.json, graph.js) to a folder,
      _site by default, ready for GitHub Pages or any static server.
  hypatia check
      Checks the wiki pages (front matter, parents, links) and says what to
      fix. Writes nothing; exits with 1 when a page has a problem.

The team comes from git history, and from GitHub when it can be read. The
optional docs/hypatia.yml sets the title, names, colors and focus lines.

GitHub data (who is working on what, questions, logins) is read when
GITHUB_TOKEN is set or the GitHub CLI is signed in (gh auth login).`;

// The repo's top folder, or the current folder outside git.
function repoRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : path.resolve(cwd);
}

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
    graph = await buildGraph({ root, token: process.env.GITHUB_TOKEN || null });
  } catch (err) {
    if (!(err instanceof WikiError)) throw err;
    console.error(`hypatia: ${err.message}`);
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

// `hypatia check`: the same checks as a build, nothing written, no GitHub.
async function check(root, argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("hypatia check");
    return 0;
  }
  if (argv.length) {
    console.error(`Unknown option "${argv[0]}". hypatia check takes no options.`);
    return 2;
  }
  try {
    const graph = await buildGraph({ root, token: null, warn: (msg) => console.error(`hypatia: ${msg}`) });
    console.log(`Wiki check passed: ${graph.nodes.length} pages, ${graph.edges.length} links and parents.`);
    return 0;
  } catch (err) {
    if (!(err instanceof WikiError)) throw err;
    console.error(`hypatia: ${err.message}`);
    return 1;
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return command ? 0 : 2;
  }
  const root = repoRoot(process.cwd());
  if (command === "serve") return serve(root, rest);
  if (command === "build") return build(root, rest);
  if (command === "check") return check(root, rest);
  console.error(`Unknown command "${command}".\n\n${HELP}`);
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
