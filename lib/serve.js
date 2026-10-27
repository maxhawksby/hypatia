// `hypatia serve`: builds the wiki data for the repo you are in, serves the
// site on localhost, opens the browser and reloads it whenever a wiki page
// changes.
//
//   hypatia serve                    # http://localhost:4410/
//   hypatia serve --port 4500        # another port
//   hypatia serve --no-open          # do not open a browser
//
// Node built-ins only. The site files ship with Hypatia (site/) and are served
// as they are; graph.json and graph.js are built in memory for this repo and
// never written into it. The small reload script is added to index.html on
// the way out.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { buildGraph, describe, repoSlug, WikiError } = require("./build-graph");
const { CONFIG_FILES } = require("./team");

const SITE = path.join(__dirname, "..", "site");
const DEFAULT_PORT = 4410;
const REFRESH_MS = 5 * 60 * 1000; // re-read GitHub this often
const POLL_MS = 1500; // backup check for file systems where fs.watch is silent
const DEBOUNCE_MS = 250;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// Runs in the browser: reload on "reload", show a note on "error-note".
const RELOAD_CLIENT = `(() => {
  let note;
  function show(msg) {
    if (!note) {
      note = document.createElement("div");
      note.setAttribute("role", "status");
      note.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:640px;margin:0 auto;" +
        "padding:12px 14px;border-radius:8px;background:#3a1d1d;color:#ffd9d4;border:1px solid #a4483d;" +
        "font:13px/1.45 system-ui,sans-serif;white-space:pre-wrap;box-shadow:0 6px 24px rgba(0,0,0,.4)";
      document.body.appendChild(note);
    }
    note.textContent = msg;
  }
  const es = new EventSource("/__hypatia/events");
  es.addEventListener("reload", () => {
    // remember where the reader was, so the page comes back at the same spot
    try {
      const reader = document.getElementById("reader-scroll");
      sessionStorage.setItem("hypatia.reading", JSON.stringify({ hash: location.hash, top: reader ? reader.scrollTop : 0, winTop: window.scrollY }));
    } catch (e) { /* storage off: the page starts at the top */ }
    location.reload();
  });
  es.addEventListener("error-note", (e) => show("The wiki could not rebuild, so you are seeing the last good version.\\n\\n" + JSON.parse(e.data).message));
  es.addEventListener("ok", () => { if (note) { note.remove(); note = null; } });
})();
`;

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") opts.open = false;
    else if (a === "--port" || a.startsWith("--port=")) {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      opts.port = Number(v);
      if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
        throw new Error(`--port needs a number from 1 to 65535, got "${v}".`);
      }
    } else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option "${a}". Try --port <number> or --no-open.`);
  }
  return opts;
}

// ---------------------------------------------------------------- GitHub

// A read token from GITHUB_TOKEN or the GitHub CLI, or null.
function githubToken() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, from: "GITHUB_TOKEN" };
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  const token = r.status === 0 ? r.stdout.trim() : "";
  return token ? { token, from: "gh" } : null;
}

// ---------------------------------------------------------------- build

// Builds the graph in memory. One build at a time; a change during a build
// queues exactly one more. The last good graph stays served when a build fails.
function createBuilder({ root, token, repo, log }) {
  let running = null;
  let again = false;
  let lastData = null; // the graph without generated_at, to skip no-op reloads
  let lastError = null;
  let graph = null;

  async function once(reason) {
    const started = Date.now();
    const warnings = [];
    let g;
    try {
      g = await buildGraph({ root, token, repo, warn: (msg) => warnings.push(msg) });
    } catch (err) {
      lastError = err instanceof WikiError ? err.message : `The builder stopped: ${err.stack || err.message}`;
      log(`Rebuild failed (${reason}):\n${indent(lastError)}`);
      return { ok: false, error: lastError };
    }
    for (const w of warnings) log(w); // e.g. GitHub unreachable
    const { generated_at, ...rest } = g;
    const data = JSON.stringify(rest);
    const changed = data !== lastData;
    const recovered = lastError !== null;
    lastData = data;
    lastError = null;
    graph = g;
    if (reason !== "start") log(`Rebuilt in ${Date.now() - started} ms (${reason})${changed ? "" : ", nothing new"}.`);
    return { ok: true, changed, recovered, summary: describe(g) };
  }

  function build(reason) {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let result;
      try {
        do {
          again = false;
          result = await once(reason);
        } while (again);
      } finally {
        running = null;
      }
      return result;
    })();
    return running;
  }

  return { build, error: () => lastError, graph: () => graph };
}

function indent(s) {
  return s.split("\n").map((l) => "    " + l).join("\n");
}

// ---------------------------------------------------------------- watch

// What can change the wiki: README.md, the config file and docs/wiki/**.
function watchedFiles(root) {
  let readmes = [];
  try {
    readmes = fs.readdirSync(root).filter((n) => /^readme\.md$/i.test(n));
  } catch {
    // the folder is gone: nothing to watch there
  }
  const files = [path.join(root, "README.md"), ...readmes.map((n) => path.join(root, n)), ...CONFIG_FILES.map((f) => path.join(root, f))];
  (function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  })(path.join(root, "docs", "wiki"));
  return files;
}

function signature(root) {
  return watchedFiles(root)
    .map((f) => {
      try {
        const s = fs.statSync(f);
        return `${f}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${f}:missing`;
      }
    })
    .join("|");
}

// Calls onChange (debounced) when a watched file is added, edited or removed.
// fs.watch on the folders gives instant events (folders survive editors that
// save by replacing the file); a slow poll covers file systems where it is silent.
function watch(root, onChange, { pollMs = POLL_MS, debounceMs = DEBOUNCE_MS } = {}) {
  let sig = signature(root);
  let timer = null;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = signature(root);
      if (now !== sig) {
        sig = now;
        onChange();
      }
    }, debounceMs);
  };
  const watchers = [];
  const dirs = [root, path.join(root, "docs"), path.join(root, "docs", "wiki")];
  for (const dir of dirs) {
    try {
      const w = fs.watch(dir, check);
      w.on("error", () => {}); // e.g. the folder was removed: the poll still covers it
      watchers.push(w);
    } catch {
      // folder missing or watching unsupported: the poll still covers it
    }
  }
  const poll = setInterval(check, pollMs);
  return () => {
    clearTimeout(timer);
    clearInterval(poll);
    watchers.forEach((w) => w.close());
  };
}

// ---------------------------------------------------------------- serve

// graph() returns the current graph (or null): served as /graph.json and
// /graph.js. Without one, /graph.json is a 404 and the site shows its sample.
function createServer({ graph = () => null } = {}) {
  const clients = new Set();

  function send(event, data = {}) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  function reply(req, res, type, body) {
    body = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname === "/__hypatia/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/__hypatia/reload.js") {
      reply(req, res, TYPES[".js"], RELOAD_CLIENT);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    // The data is built for this repo, never read from site/.
    if (url.pathname === "/graph.json" || url.pathname === "/graph.js") {
      const g = graph();
      if (!g) {
        res.writeHead(404, { "Content-Type": TYPES[".txt"] }).end("Not built yet");
        return;
      }
      if (url.pathname === "/graph.json") reply(req, res, TYPES[".json"], JSON.stringify(g, null, 1));
      else reply(req, res, TYPES[".js"], graphScript(g));
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(SITE, "." + rel);
    if (file !== SITE && !file.startsWith(SITE + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "Content-Type": TYPES[".txt"] }).end("Not found");
        return;
      }
      const ext = path.extname(file).toLowerCase();
      if (file === path.join(SITE, "index.html")) {
        const tag = '<script src="/__hypatia/reload.js"></script>';
        const html = body.toString("utf8");
        body = Buffer.from(html.includes("</body>") ? html.replace("</body>", `${tag}\n</body>`) : html + tag);
      }
      reply(req, res, TYPES[ext] || "application/octet-stream", body);
    });
  });

  // Keeps idle connections alive through proxies and sleeping laptops.
  const ping = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25000);
  server.on("close", () => clearInterval(ping));

  return { server, send, clients };
}

// The same data as a script, for viewers that block fetch(): a sandboxed
// frame (Lavish review) or opening index.html straight from disk.
function graphScript(g) {
  return "window.HYPATIA_GRAPH = " + JSON.stringify(g) + ";\n";
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

// ---------------------------------------------------------------- browser

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function openBrowser(url) {
  let cmd, args;
  const extra = {};
  if (process.platform === "win32") {
    // `start` takes the first quoted argument as a window title, hence "".
    [cmd, args] = ["cmd", ["/c", "start", '""', url]];
    extra.windowsVerbatimArguments = true;
  } else if (isWsl()) {
    [cmd, args] = ["cmd.exe", ["/c", "start", url]];
    // cmd.exe warns about Linux folders as its working folder; give it a Windows one.
    if (fs.existsSync("/mnt/c")) extra.cwd = "/mnt/c";
  } else if (process.platform === "darwin") [cmd, args] = ["open", [url]];
  else [cmd, args] = ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true, ...extra });
    child.on("error", () => {}); // no browser opener: the banner still shows the address
    child.unref();
  } catch {
    // same as above
  }
}

// ---------------------------------------------------------------- main

// Runs the server until Ctrl+C. root is the repo folder.
async function serve(root, argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    console.log("hypatia serve [--port <number>] [--no-open]");
    return 0;
  }

  const log = (msg) => console.log(`  ${time()}  ${msg}`);
  const gh = githubToken();
  const repo = process.env.GITHUB_REPOSITORY || repoSlug(root);

  console.log(`\n  Building the wiki for ${path.basename(root)}...`);
  const builder = createBuilder({ root, token: gh && repo ? gh.token : null, repo, log });
  const first = await builder.build("start");
  if (!first.ok) {
    console.error("\n  The wiki pages have a problem, so there is nothing to show yet:\n");
    console.error(indent(builder.error()));
    console.error("\n  Fix it and run `hypatia serve` again.\n");
    return 1;
  }

  const { server, send } = createServer({ graph: builder.graph });
  let port;
  try {
    port = await listen(server, opts.port);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  Port ${opts.port} is already in use. Is the wiki already open in another terminal?`);
      console.error(`  Use another port: hypatia serve --port ${opts.port + 1}\n`);
    } else console.error(`\n  Could not start the server: ${err.message}\n`);
    return 1;
  }
  const url = `http://localhost:${port}/`;

  let github;
  if (!repo) github = "off: the origin remote is not on GitHub";
  else if (!gh) github = 'off: run "gh auth login" to see who is working on what';
  else github = `on for ${repo} (token from ${gh.from}), refreshed every 5 minutes`;
  console.log(`
  Wiki is running   ${url}

  ${first.summary}
  Live     edits to README.md, docs/wiki/ and ${CONFIG_FILES[0]} reload the page
  GitHub   ${github}
  Stop     Ctrl+C
`);

  async function rebuild(reason) {
    const r = await builder.build(reason);
    if (!r.ok) send("error-note", { message: r.error });
    else if (r.changed) send("reload");
    else if (r.recovered) send("ok");
  }

  const stopWatching = watch(root, () => rebuild("a page changed"));
  const refresh = setInterval(() => rebuild("5 minute refresh"), REFRESH_MS);
  if (opts.open) openBrowser(url);

  return new Promise((resolve) => {
    const stop = () => {
      console.log("\n  Stopped the wiki. Bye!\n");
      stopWatching();
      clearInterval(refresh);
      server.close();
      resolve(0);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function time() {
  return new Date().toTimeString().slice(0, 8);
}

module.exports = { parseArgs, createServer, createBuilder, watch, graphScript, serve, SITE, RELOAD_CLIENT };
