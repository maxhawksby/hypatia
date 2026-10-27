// The checks `hypatia check` makes on top of a build, about whether the wiki
// still fits the repo and can be found:
// - errors: a page's `code:` path or glob that matches no file in the repo
//   (the page points at nothing, usually because the code moved);
// - warnings: a hub page (parent: home) that no chain of links leads to from
//   README.md, so readers of the README never find it;
// - todos: how many "TODO(" markers the pages hold, as information.
//
// Node built-ins only.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { matches } = require("./globs");

// Every file in the repo, tracked or new (ignored files left out), or null
// when git cannot list them.
function repoFiles(root) {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  return r.stdout.split("\0").filter(Boolean);
}

// Code globs that match nothing: [{ path, glob }].
function emptyCode(graph, files) {
  const out = [];
  for (const n of graph.nodes) {
    for (const glob of n.code || []) if (!files.some((f) => matches(f, [glob]))) out.push({ path: n.path, glob });
  }
  return out;
}

// Hub pages no link path from the center page reaches: their nodes.
function unreachableHubs(graph) {
  const next = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const n of graph.nodes) for (const from of n.backlinks || []) if (next.has(from)) next.get(from).push(n.id);
  const seen = new Set([graph.center]);
  const queue = [graph.center];
  while (queue.length) {
    for (const id of next.get(queue.shift()) || []) {
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return graph.nodes.filter((n) => n.parent === graph.center && !seen.has(n.id));
}

// "TODO(" markers per page: { count, pages: [path] }.
function todos(graph) {
  let count = 0;
  const pages = [];
  for (const n of graph.nodes) {
    const k = (n.markdown.match(/TODO\(/g) || []).length;
    if (k) {
      count += k;
      pages.push(n.path);
    }
  }
  return { count, pages };
}

function lint(root, graph) {
  const errors = [];
  const warnings = [];
  const files = repoFiles(root);
  if (files) {
    for (const { path: page, glob } of emptyCode(graph, files)) {
      errors.push(`${page}: code: '${glob}' matches no file in the repo. Point it at the code the page is about, or remove it.`);
    }
  }
  const center = graph.nodes.find((n) => n.id === graph.center);
  // without a README there is nothing to link from: no warning to act on
  if (center && fs.existsSync(path.join(root, center.path))) {
    for (const hub of unreachableHubs(graph)) {
      warnings.push(`${hub.path} is a hub page (parent: home), but no link leads to it from ${center.path}. Link it from ${center.path}, or from a page linked there, so readers can find it.`);
    }
  }
  return { errors, warnings, todos: todos(graph) };
}

module.exports = { lint, repoFiles, emptyCode, unreachableHubs, todos };
