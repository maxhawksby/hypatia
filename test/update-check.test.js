// Tests for the update check (lib/update-check.js): `npm test`. A small
// local server stands in for the npm registry; the real one is never asked.
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawn } = require("child_process");
const { makeRepo } = require("./helpers");
const { updateCheck, updateCommand, offReason, cacheFile, DAY_MS } = require("../lib/update-check");
const { createServer } = require("../lib/serve");
const { VERSION } = require("../lib/init");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");

// A stand-in registry. reply(req) gives { status, body, delay }; hits counts
// the requests it got.
async function fakeRegistry(reply) {
  const reg = { hits: 0 };
  reg.server = http.createServer((req, res) => {
    reg.hits++;
    const { status = 200, body = "{}", delay = 0 } = reply(req);
    const t = setTimeout(() => res.writeHead(status, { "Content-Type": "application/json" }).end(body), delay);
    res.on("close", () => clearTimeout(t));
  });
  await new Promise((resolve) => reg.server.listen(0, "127.0.0.1", resolve));
  reg.url = `http://127.0.0.1:${reg.server.address().port}/hypatia/latest`;
  reg.close = () => new Promise((resolve) => reg.server.close(resolve));
  return reg;
}

const latest = (version) => () => ({ body: JSON.stringify({ name: "hypatia", version }) });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-cache-"));
const GLOBAL = path.join(os.tmpdir(), "no-such-prefix", "lib", "node_modules", "hypatia");

// Runs the check against reg with a fresh cache folder (or the one given).
function check(reg, opts = {}) {
  const env = { HYPATIA_REGISTRY: reg.url, XDG_CACHE_HOME: opts.cache || tmpDir(), ...opts.env };
  return updateCheck("check", { current: "0.3.0", where: GLOBAL, timeoutMs: 1000, ...opts, env });
}

test("a newer version gives one line with the update command", async () => {
  const reg = await fakeRegistry(latest("0.3.1"));
  try {
    const info = await check(reg);
    assert.deepStrictEqual(info, {
      latest: "0.3.1",
      current: "0.3.0",
      command: "npm install -g hypatia@latest",
      line: "hypatia: Hypatia 0.3.1 is out (you have 0.3.0). Update with: npm install -g hypatia@latest",
    });
  } finally {
    await reg.close();
  }
});

test("the same or an older version gives no notice", async () => {
  for (const version of ["0.3.0", "0.2.9", "0.2.10"]) {
    const reg = await fakeRegistry(latest(version));
    try {
      assert.strictEqual(await check(reg), null, version);
      assert.strictEqual(reg.hits, 1);
    } finally {
      await reg.close();
    }
  }
  // 0.10.0 is newer than 0.9.0, not older
  const reg = await fakeRegistry(latest("0.10.0"));
  try {
    assert.strictEqual((await check(reg, { current: "0.9.0" })).latest, "0.10.0");
  } finally {
    await reg.close();
  }
});

test("the answer is kept for a day: a second call uses it, a stale one asks again", async () => {
  let version = "0.3.1";
  const reg = await fakeRegistry(() => ({ body: JSON.stringify({ version }) }));
  const cache = tmpDir();
  try {
    const now = Date.UTC(2026, 0, 1);
    assert.strictEqual((await check(reg, { cache, now })).latest, "0.3.1");
    assert.strictEqual(reg.hits, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(cache, "hypatia", "update-check.json"), "utf8"));
    assert.deepStrictEqual(saved, { registry: reg.url, checked: now, latest: "0.3.1" });

    version = "0.4.0";
    assert.strictEqual((await check(reg, { cache, now: now + DAY_MS - 1000 })).latest, "0.3.1");
    assert.strictEqual(reg.hits, 1, "a fresh cache is not refetched");

    assert.strictEqual((await check(reg, { cache, now: now + DAY_MS + 1000 })).latest, "0.4.0");
    assert.strictEqual(reg.hits, 2, "a stale cache is refetched");

    // a clock that went backwards does not trust the cache forever
    assert.strictEqual((await check(reg, { cache, now: now - DAY_MS })).latest, "0.4.0");
    assert.strictEqual(reg.hits, 3);
  } finally {
    await reg.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("an answer saved from another registry is not used", async () => {
  const reg = await fakeRegistry(latest("0.3.1"));
  const cache = tmpDir();
  try {
    fs.mkdirSync(path.join(cache, "hypatia"));
    fs.writeFileSync(path.join(cache, "hypatia", "update-check.json"), JSON.stringify({ registry: "http://elsewhere/", checked: Date.now(), latest: "9.9.9" }));
    assert.strictEqual((await check(reg, { cache })).latest, "0.3.1");
    assert.strictEqual(reg.hits, 1);
  } finally {
    await reg.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("CI and HYPATIA_NO_UPDATE_CHECK turn it off, and so does a git checkout of Hypatia", async () => {
  const reg = await fakeRegistry(latest("9.9.9"));
  try {
    assert.strictEqual(await check(reg, { env: { CI: "true" } }), null);
    assert.strictEqual(await check(reg, { env: { HYPATIA_NO_UPDATE_CHECK: "1" } }), null);
    assert.strictEqual(reg.hits, 0);
  } finally {
    await reg.close();
  }
  const dev = tmpDir();
  try {
    fs.mkdirSync(path.join(dev, ".git"));
    assert.match(offReason({}, dev), /git checkout/);
    // a registry named on purpose (the tests, a by-hand check) turns it back on
    assert.strictEqual(offReason({ HYPATIA_REGISTRY: "http://127.0.0.1:1/" }, dev), null);
    assert.strictEqual(offReason({}, path.join(dev, "no-git")), null);
  } finally {
    fs.rmSync(dev, { recursive: true, force: true });
  }
});

test("a registry that is down, slow or broken gives no notice and no crash", async () => {
  // down: nothing listens on the port any more
  const gone = await fakeRegistry(latest("9.9.9"));
  await gone.close();
  assert.strictEqual(await check(gone), null);

  for (const reply of [() => ({ status: 500 }), () => ({ body: "not json" }), () => ({ body: '{"version":"soon"}' }), () => ({ body: "null" })]) {
    const reg = await fakeRegistry(reply);
    try {
      assert.strictEqual(await check(reg), null);
    } finally {
      await reg.close();
    }
  }

  // slow: the check gives up at its timeout
  const slow = await fakeRegistry(() => ({ delay: 5000, body: '{"version":"9.9.9"}' }));
  try {
    const started = Date.now();
    assert.strictEqual(await check(slow, { timeoutMs: 200 }), null);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  } finally {
    slow.server.closeAllConnections();
    await slow.close();
  }
});

test("a failed ask is saved too, keeping the last answer, so offline costs one timeout a day", async () => {
  let up = true;
  const reg = await fakeRegistry(() => (up ? { body: '{"version":"0.3.1"}' } : { status: 503 }));
  const cache = tmpDir();
  try {
    const now = Date.UTC(2026, 0, 1);
    await check(reg, { cache, now });
    up = false;
    assert.strictEqual((await check(reg, { cache, now: now + DAY_MS + 1 })).latest, "0.3.1", "the last answer still counts");
    assert.strictEqual((await check(reg, { cache, now: now + DAY_MS + 2 })).latest, "0.3.1");
    assert.strictEqual(reg.hits, 2, "the failure was saved, so it did not ask again");
  } finally {
    await reg.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("a cache folder it cannot write still gives the notice", async () => {
  const reg = await fakeRegistry(latest("0.3.1"));
  const dir = tmpDir();
  try {
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "");
    assert.strictEqual((await check(reg, { cache: file })).latest, "0.3.1");
  } finally {
    await reg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the cache lives in XDG_CACHE_HOME, else ~/.cache", () => {
  assert.strictEqual(cacheFile({ XDG_CACHE_HOME: "/x" }), path.join("/x", "hypatia", "update-check.json"));
  assert.strictEqual(cacheFile({}), path.join(os.homedir(), ".cache", "hypatia", "update-check.json"));
});

test("the command matches how Hypatia was installed", () => {
  const dir = tmpDir();
  try {
    // npx's cache has a package.json of its own: npx wins
    const npx = path.join(dir, ".npm", "_npx", "a1b2c3", "node_modules", "hypatia");
    fs.mkdirSync(npx, { recursive: true });
    fs.writeFileSync(path.join(dir, ".npm", "_npx", "a1b2c3", "package.json"), "{}");
    assert.deepStrictEqual(updateCommand("serve", npx), { how: "npx", text: "npx hypatia@latest serve" });

    const project = path.join(dir, "app", "node_modules", "hypatia");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(dir, "app", "package.json"), "{}");
    assert.deepStrictEqual(updateCommand("check", project), { how: "project", text: "npm install hypatia@latest" });

    const global = path.join(dir, "usr", "lib", "node_modules", "hypatia");
    fs.mkdirSync(global, { recursive: true });
    assert.deepStrictEqual(updateCommand("check", global), { how: "global", text: "npm install -g hypatia@latest" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("from the npx cache, the notice says how to run the new one", async () => {
  const reg = await fakeRegistry(latest("0.3.1"));
  try {
    const info = await check(reg, { where: path.join(os.tmpdir(), ".npm", "_npx", "x", "node_modules", "hypatia") });
    assert.strictEqual(info.line, "hypatia: Hypatia 0.3.1 is out (you have 0.3.0). Use it with: npx hypatia@latest check");
  } finally {
    await reg.close();
  }
});

test("serve hands the answer to the site at /__hypatia/update", async () => {
  const get = (port) =>
    new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/__hypatia/update" }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(JSON.parse(body)));
      }).on("error", reject);
    });
  const listen = (s) => new Promise((resolve) => s.server.listen(0, "127.0.0.1", () => resolve(s.server.address().port)));
  const info = { latest: "0.3.1", current: "0.3.0", command: "npm install -g hypatia@latest", line: "..." };
  const withInfo = createServer({ update: () => Promise.resolve(info) });
  const none = createServer();
  try {
    assert.deepStrictEqual(await get(await listen(withInfo)), info);
    assert.strictEqual(await get(await listen(none)), null);
  } finally {
    withInfo.server.close();
    none.server.close();
  }
});

test("hypatia check prints the notice after its output; build never asks", async () => {
  const reg = await fakeRegistry(latest("9.9.9"));
  const repo = makeRepo({ generic: true });
  const cache = tmpDir();
  try {
    const env = { ...process.env, HYPATIA_REGISTRY: reg.url, XDG_CACHE_HOME: cache };
    delete env.HYPATIA_NO_UPDATE_CHECK;
    delete env.CI;
    const run = (args) => new Promise((resolve) => {
      // not spawnSync: this process's stand-in registry has to answer
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo.root, env });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (status) => resolve({ status, out, err }));
    });
    const r = await run(["check"]);
    const lines = r.err.trim().split("\n");
    assert.match(lines[lines.length - 1], new RegExp(`^hypatia: Hypatia 9\\.9\\.9 is out \\(you have ${VERSION.replace(/\./g, "\\.")}\\)\\. Update with: npm install -g hypatia@latest$`));
    assert.strictEqual(reg.hits, 1);

    const out = path.join(cache, "site");
    const b = await run(["build", "--out", out]);
    assert.strictEqual(b.status, 0, b.err);
    assert.doesNotMatch(b.out + b.err, /is out/);
    assert.strictEqual(reg.hits, 1);
  } finally {
    await reg.close();
    repo.cleanup();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

