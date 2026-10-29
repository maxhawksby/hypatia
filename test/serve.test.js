// Tests for the local wiki server (lib/serve.js) and the hypatia CLI: `npm test`.
// The first ones check the server on its own, the last ones run the CLI.
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawn, spawnSync } = require("child_process");
const { parseArgs, createServer, createBuilder, watch } = require("../lib/serve");
const { makeRepo, write } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

function start(opts) {
  const s = createServer(opts);
  return new Promise((resolve) => s.server.listen(0, "127.0.0.1", () => resolve({ ...s, port: s.server.address().port })));
}

// Collects Server-Sent Events from /__hypatia/events until stopped.
function listen(port) {
  const events = [];
  let res;
  const ready = new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/__hypatia/events" }, (r) => {
      res = r;
      let buf = "";
      r.on("data", (d) => {
        buf += d;
        if (buf.includes(": connected")) resolve();
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^event: (.+)\ndata: (.*)$/m.exec(block);
          if (m) events.push({ event: m[1], data: JSON.parse(m[2]) });
        }
      });
    }).on("error", reject);
  });
  return { events, ready, stop: () => res && res.destroy() };
}

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("timed out waiting");
}

test("parseArgs reads --port and --no-open", () => {
  assert.deepStrictEqual(parseArgs([]), { port: 4410, open: true });
  assert.deepStrictEqual(parseArgs(["--port", "4500", "--no-open"]), { port: 4500, open: false });
  assert.strictEqual(parseArgs(["--port=4501"]).port, 4501);
  assert.throws(() => parseArgs(["--port", "abc"]), /--port needs a number/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
});

test("serves index.html with the reload script, the site files and the built data", async () => {
  const graph = { version: 2, nodes: [{ id: "home" }] };
  const s = await start({ graph: () => graph });
  try {
    const index = await get(s.port, "/");
    assert.strictEqual(index.status, 200);
    assert.match(index.body, /<script src="\/__hypatia\/reload\.js"><\/script>\s*<\/body>/);
    assert.strictEqual(index.headers["cache-control"], "no-store");
    const app = await get(s.port, "/app.js");
    assert.strictEqual(app.status, 200);
    assert.match(app.headers["content-type"], /javascript/);
    const client = await get(s.port, "/__hypatia/reload.js");
    assert.match(client.body, /EventSource\("\/__hypatia\/events"\)/);
    assert.deepStrictEqual(JSON.parse((await get(s.port, "/graph.json")).body), graph);
    assert.strictEqual((await get(s.port, "/graph.js")).body, "window.HYPATIA_GRAPH = " + JSON.stringify(graph) + ";\n");
    assert.strictEqual((await get(s.port, "/nope.txt")).status, 404);
    assert.notStrictEqual((await get(s.port, "/%2e%2e/package.json")).status, 200);
  } finally {
    s.server.close();
  }
});

test("the reload script is valid JavaScript", () => {
  assert.doesNotThrow(() => new Function(require("../lib/serve").RELOAD_CLIENT));
});

test("a live reload saves the reading position under the key the site restores it from", () => {
  const { RELOAD_CLIENT, SITE } = require("../lib/serve");
  const app = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
  assert.match(RELOAD_CLIENT, /sessionStorage\.setItem\("hypatia\.reading"/);
  assert.match(app, /sessionStorage\.getItem\("hypatia\.reading"\)/);
});

test("without built data, graph.json is missing so the site falls back to its sample", async () => {
  const s = await start();
  try {
    assert.strictEqual((await get(s.port, "/graph.json")).status, 404);
    assert.strictEqual((await get(s.port, "/sample-graph.json")).status, 200);
  } finally {
    s.server.close();
  }
});

test("pushes events to open browsers over Server-Sent Events", async () => {
  const s = await start();
  const l = listen(s.port);
  try {
    await l.ready;
    s.send("reload");
    await until(() => l.events.length);
    assert.deepStrictEqual(l.events, [{ event: "reload", data: {} }]);
  } finally {
    l.stop();
    for (const res of s.clients) res.end();
    s.server.close();
  }
});

test("live reload: editing a page rebuilds and reloads; a broken page shows a note and keeps the last good data", async () => {
  const repo = makeRepo();
  const logs = [];
  const builder = createBuilder({ root: repo.root, token: null, repo: null, log: (m) => logs.push(m) });
  const s = await start({ graph: builder.graph });
  const l = listen(s.port);
  // the same wiring as `hypatia serve`
  const rebuild = async () => {
    const r = await builder.build("a page changed");
    if (!r.ok) s.send("error-note", { message: r.error });
    else if (r.changed) s.send("reload");
    else if (r.recovered) s.send("ok");
  };
  const stopWatching = watch(repo.root, rebuild, { pollMs: 200, debounceMs: 50 });
  const page = path.join(repo.root, "docs/wiki/movement.md");
  const original = fs.readFileSync(page, "utf8");
  const movement = async () => JSON.parse((await get(s.port, "/graph.json")).body).nodes.find((n) => n.id === "movement");
  try {
    assert.ok((await builder.build("start")).ok);
    await l.ready;

    fs.writeFileSync(page, original + "\nA new line about stairs.\n");
    await until(() => l.events.some((e) => e.event === "reload"));
    assert.match((await movement()).markdown, /stairs/);

    fs.writeFileSync(page, original.replace("parent: oak", "parent: nowhere"));
    await until(() => l.events.some((e) => e.event === "error-note"));
    assert.match(l.events.find((e) => e.event === "error-note").data.message, /no page called 'nowhere'/);
    assert.match((await movement()).markdown, /stairs/, "the last good data is still served");

    fs.writeFileSync(page, original + "\nA new line about stairs.\n"); // back to the last good version
    await until(() => l.events.some((e) => e.event === "ok"));

    const reloads = l.events.filter((e) => e.event === "reload").length;
    fs.utimesSync(page, new Date(), new Date(Date.now() + 5000)); // touched, same content
    await until(() => logs.some((m) => /nothing new/.test(m)));
    assert.strictEqual(l.events.filter((e) => e.event === "reload").length, reloads, "no reload when nothing changed");

    write(repo.root, "docs/wiki/stairs.md", "---\ntitle: Stairs\nparent: movement\n---\nClimbing stairs.\n");
    await until(() => l.events.filter((e) => e.event === "reload").length > reloads);
    assert.ok(JSON.parse((await get(s.port, "/graph.json")).body).nodes.some((n) => n.id === "stairs"), "a new page shows up");
  } finally {
    stopWatching();
    l.stop();
    for (const res of s.clients) res.end();
    s.server.close();
    repo.cleanup();
  }
});

test("live reload: a link to a page not written yet keeps the site updating, shown as missing", async () => {
  const repo = makeRepo();
  const logs = [];
  const builder = createBuilder({ root: repo.root, token: null, repo: null, log: (m) => logs.push(m) });
  const s = await start({ graph: builder.graph });
  try {
    assert.ok((await builder.build("start")).ok);
    assert.deepStrictEqual(JSON.parse((await get(s.port, "/__hypatia/links")).body), []);
    const page = path.join(repo.root, "docs/wiki/movement.md");
    fs.writeFileSync(page, fs.readFileSync(page, "utf8") + "\nNext: [Stairs](stairs.md), still being written.\n");
    const r = await builder.build("a page changed");
    assert.ok(r.ok && r.changed, "no error note: the rebuild goes through and reloads");
    const g = JSON.parse((await get(s.port, "/graph.json")).body);
    assert.match(g.nodes.find((n) => n.id === "movement").markdown, /still being written/);
    assert.deepStrictEqual(JSON.parse((await get(s.port, "/__hypatia/links")).body).map((l) => [l.from, l.path]), [["docs/wiki/movement.md", "docs/wiki/stairs.md"]]);
    assert.strictEqual(logs.filter((m) => /^Broken links:/.test(m)).length, 1);
    await builder.build("5 minute refresh");
    assert.strictEqual(logs.filter((m) => /^Broken links:/.test(m)).length, 1, "said once, not on every rebuild");
    write(repo.root, "docs/wiki/stairs.md", "---\ntitle: Stairs\nparent: movement\n---\nClimbing.\n");
    await builder.build("a page changed");
    assert.ok(logs.includes("Broken links: all fixed now."));
    assert.strictEqual(JSON.parse((await get(s.port, "/graph.json")).body).missing, undefined);
    fs.rmSync(path.join(repo.root, "docs/wiki/stairs.md"));
    const check = spawnSync(process.execPath, [CLI, "check"], { cwd: repo.root, encoding: "utf8" });
    assert.strictEqual(check.status, 1, "check still fails on it");
    assert.match(check.stderr, /links to 'stairs.md', but that page does not exist/);
  } finally {
    s.server.close();
    repo.cleanup();
  }
});

test("hypatia build writes the site and this repo's data, from any folder inside the repo", () => {
  const repo = makeRepo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-out-"));
  try {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    const r = spawnSync(process.execPath, [CLI, "build", "--out", out], { cwd: path.join(repo.root, "docs", "wiki"), env, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /5 pages, 4 parent edges, 1 cross links, 2 people/);
    for (const f of ["index.html", "app.js", "style.css", "graph.json", "graph.js"]) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8")).repo, "acme/notes-app");
  } finally {
    repo.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("hypatia serve starts on the repo it is run in, names it like the site, and explains a broken wiki", async () => {
  const repo = makeRepo();
  const env = { ...process.env, GH_CONFIG_DIR: path.join(repo.root, "no-gh") }; // never use a real GitHub login here
  delete env.GITHUB_TOKEN;
  try {
    const child = spawn(process.execPath, [CLI, "serve", "--port", "0", "--no-open"], { cwd: repo.root, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    try {
      await until(() => /Wiki is running/.test(out));
      const port = Number(/localhost:(\d+)/.exec(out)[1]);
      const g = JSON.parse((await get(port, "/graph.json")).body);
      assert.strictEqual(g.repo, "acme/notes-app");
      assert.match(out, /5 pages/);
      assert.notStrictEqual(g.title, path.basename(repo.root));
      assert.ok(out.includes(`Building the wiki for ${g.title}...`), "named like the site, not like the folder");
    } finally {
      child.kill("SIGTERM");
    }

    write(repo.root, "docs/wiki/movement.md", "---\ntitle: Movement\n---\n");
    const r = spawnSync(process.execPath, [CLI, "serve", "--no-open"], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /needs both 'title' and 'parent'/);
  } finally {
    repo.cleanup();
  }
});

test("hypatia with no command or an unknown one prints the help", () => {
  const none = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.strictEqual(none.status, 2);
  assert.match(none.stdout, /^  serve +Open the wiki/m);
  const bad = spawnSync(process.execPath, [CLI, "nope"], { encoding: "utf8" });
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /Unknown command "nope"/);
  assert.doesNotMatch(bad.stderr, /Did you mean/);
  assert.match(bad.stderr, /hypatia help <command>/);
});

test("a mistyped command suggests the closest one", () => {
  const r = spawnSync(process.execPath, [CLI, "chek"], { encoding: "utf8" });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /Did you mean "hypatia check"\?/);
});

test("hypatia help <command> and <command> --help print that command's details", () => {
  const viaHelp = spawnSync(process.execPath, [CLI, "help", "check"], { encoding: "utf8" });
  assert.strictEqual(viaHelp.status, 0);
  assert.match(viaHelp.stdout, /^hypatia check \[--base <ref>\]/);
  assert.match(viaHelp.stdout, /privacy guard/);
  const viaFlag = spawnSync(process.execPath, [CLI, "check", "--help"], { encoding: "utf8" });
  assert.strictEqual(viaFlag.stdout, viaHelp.stdout);
  const unknown = spawnSync(process.execPath, [CLI, "help", "nope"], { encoding: "utf8" });
  assert.strictEqual(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command "nope"/);
});
