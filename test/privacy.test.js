// Tests for the privacy guard (lib/privacy.js) and private pages: every kind
// of personal data and key it must catch, what it must leave alone, the
// allow list, the publishing build refusing, and private pages never reaching
// the published site. `npm test`.
//
// Every "secret" here is made up, and most are built from pieces so the file
// itself never holds a whole key.
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const privacy = require("../lib/privacy");
const { buildGraph } = require("../lib/build-graph");
const { createBuilder, createServer } = require("../lib/serve");
const { makeRepo, write } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");
const r = (s, n) => s.repeat(n);

// [kind, a line holding it, the value]
const SECRETS = [
  ["email address", "Write to jane.doe@gmail.com for access.", "jane.doe@gmail.com"],
  ["phone number", "Call (860) 555-0142 after 5.", "(860) 555-0142"],
  ["phone number", "Or 860.555.0142.", "860.555.0142"],
  ["phone number", "Abroad: +44 20 7946 0958.", "+44 20 7946 0958"],
  ["social security number", "SSN 123-45-6789 on file.", "123-45-6789"],
  ["ID number", "Her student ID: 2345678 is in the sheet.", "2345678"],
  ["ID number", "PeopleSoft number 1234567", "1234567"],
  ["ID number", "ID: 98765432", "98765432"],
  ["NetID", "NetID abc12345 signs in.", "abc12345"],
  ["AWS access key", "key AKIA" + r("Q", 16) + " here", "AKIA" + r("Q", 16)],
  ["AWS secret key", "aws_secret_access_key = " + r("aB3/", 10), r("aB3/", 10)],
  ["GitHub token", "token ghp_" + r("a1", 18), "ghp_" + r("a1", 18)],
  ["GitHub token", "github_pat_" + r("A1b", 20), "github_pat_" + r("A1b", 20)],
  ["Stripe secret key", "STRIPE=sk_" + "live_" + r("x9", 12), "sk_" + "live_" + r("x9", 12)],
  ["Stripe secret key", "whsec_" + r("Ab1", 10), "whsec_" + r("Ab1", 10)],
  ["Supabase secret key", "sb_secret_" + r("Zz9", 8), "sb_secret_" + r("Zz9", 8)],
  ["JSON web token", "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9." + "eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLWhlcmU", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLWhlcmU"],
  ["OpenAI API key", "OPENAI_API_KEY=sk-proj-" + r("Ab3", 14), "sk-proj-" + r("Ab3", 14)],
  ["Anthropic API key", "sk-ant-api03-" + r("Xy7", 10), "sk-ant-api03-" + r("Xy7", 10)],
  ["Slack token", "xoxb-" + r("12", 6) + "-abcdef", "xoxb-" + r("12", 6) + "-abcdef"],
  ["Google API key", "AIza" + r("Sy1", 11) + "ab", "AIza" + r("Sy1", 11) + "ab"],
  ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----"],
  ["connection string with a password", "DATABASE_URL=postgres://app:" + "hunter2pw@db.abcd.supabase.co:5432/postgres", "hunter2pw"],
  ["connection string with a password", "mongodb+srv://admin:" + "S3cretPass@cluster0.example.net/app", "S3cretPass"],
];

for (const [kind, line, value] of SECRETS) {
  test(`privacy: finds a ${kind} and masks it (${value.slice(0, 12)}...)`, () => {
    const hits = privacy.scanText(`intro\n${line}\n`);
    assert.deepStrictEqual(hits.map((h) => [h.kind, h.line]), [[kind, 2]]);
    assert.ok(!hits[0].masked.includes(value) || value.length < 4, "the masked value never repeats the secret");
    assert.ok(hits[0].masked.length < value.length + 4);
  });
}

test("privacy: leaves ordinary docs alone (dates, versions, addresses of things, placeholders)", () => {
  const text = [
    "Released 2024-10-27 as v1.2.3; build 20241027.1; ip 192.168.1.10:8080; port 56421.",
    "Images: logo@2x.png and icon@3x.webp. Packages: react@18.3.1, @supabase/supabase-js@2.45.0.",
    "Clone git@github.com:acme/app.git. Bot mail comes from noreply@github.com.",
    "Sign in as user@example.com, ana@example.edu or firstname.lastname@uconn.edu.",
    "postgres://postgres:postgres@localhost:54322/postgres and postgres://user:<password>@db.host.co/app",
    "redis://:${REDIS_PASSWORD}@cache.internal:6379 and https://user:${TOKEN}@host.example.com",
    "Commit 9fceb02d0ae598e95dc970b74767f19372d61af8, uuid 123e4567-e89b-12d3-a456-426614174000.",
    "A publishable key looks like pk_" + "test_abc, an anon key is public by design; sk-learn-style-names-are-fine.",
    "Phone layouts at 390px, 1280x720 video, 60 fps, 3-5 seconds, $50-300 per video, 2-4 hours.",
    "Student IDs are 7 digits; never paste one here. Use <student-id>.",
  ].join("\n");
  assert.deepStrictEqual(privacy.scanText(text, privacy.allowList()), []);
});

test("privacy: allow list - team noreply addresses, reserved domains, and the config's allow:", () => {
  const allowed = privacy.allowList({ logins: ["ana-gh"], allow: ["support@acme.dev", "@team.acme.dev", "sk_" + "test_*"] });
  const text = [
    "1234+ana-gh@users.noreply.github.com",
    "ana-gh@users.noreply.github.com",
    "999+stranger@users.noreply.github.com",
    "help@example.org x@sub.example.com y@foo.test",
    "support@acme.dev sales@acme.dev",
    "bo@team.acme.dev",
    "sk_" + "test_" + r("a1", 10) + " sk_" + "live_" + r("a1", 10),
  ].join("\n");
  const hits = privacy.scanText(text, allowed);
  assert.deepStrictEqual(hits.map((h) => [h.line, h.kind]), [
    [3, "email address"],
    [5, "email address"],
    [7, "Stripe secret key"],
  ]);
  assert.strictEqual(hits[1].masked, "s***@a***.dev");
});

test("privacy: the config file's allow: list is read", () => {
  const { parseConfig } = require("../lib/team");
  assert.deepStrictEqual(parseConfig('allow: [help@acme.dev, "sk_test_*"]\n').allow, ["help@acme.dev", "sk_test_*"]);
  assert.deepStrictEqual(parseConfig("allow:\n  - help@acme.dev\n").allow, ["help@acme.dev"]);
  assert.deepStrictEqual(parseConfig("title: x\n").allow, []);
});

// A page seeded with a made-up email and key.
const SEEDED = `---
title: Payments
parent: senses
---

# Payments

Ask jane.doe@gmail.com for the key.

STRIPE_KEY=sk_${"live_"}${r("Zq7", 8)}
`;

test("the publishing build refuses a page with an email and a key, naming the page and line, masked", () => {
  const repo = makeRepo({ generic: true });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-out-")), "site");
  try {
    write(repo.root, "docs/wiki/payments.md", SEEDED);
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    const build = spawnSync(process.execPath, [CLI, "build", "--out", out], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(build.status, 1);
    assert.match(build.stderr, /Nothing was written/);
    assert.match(build.stderr, /docs\/wiki\/payments\.md:8: email address j\*\*\*@g\*\*\*\.com/);
    assert.match(build.stderr, /docs\/wiki\/payments\.md:10: Stripe secret key sk_l\*\*\*\*/);
    assert.doesNotMatch(build.stderr, /jane\.doe|Zq7Zq7/, "the values themselves are never printed");
    assert.ok(!fs.existsSync(out), "nothing written");

    const check = spawnSync(process.execPath, [CLI, "check"], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(check.status, 1);
    assert.match(check.stderr, /The wiki check failed: the public site would show personal data or secrets/);

    // allowed in the config: the build goes ahead
    write(repo.root, "docs/hypatia.yml", `allow: [jane.doe@gmail.com, "sk_live_*"]\n`);
    const allowed = spawnSync(process.execPath, [CLI, "build", "--out", out], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(allowed.status, 0, allowed.stderr);
  } finally {
    repo.cleanup();
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test("the guard scans the site data too: a commit message with an address stops the build", () => {
  const repo = makeRepo({ generic: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-out-"));
  try {
    const { commit } = require("./helpers");
    write(repo.root, "docs/wiki/senses.md", fs.readFileSync(path.join(repo.root, "docs/wiki/senses.md"), "utf8") + "\nMore.\n");
    commit(repo.root, { name: "Ben Carter", email: "ben@example.com" }, "Senses: as asked by bob.smith@gmail.com");
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    const build = spawnSync(process.execPath, [CLI, "build", "--out", out], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(build.status, 1);
    assert.match(build.stderr, /site data \(recent\[0\]\.message\): email address b\*\*\*@g\*\*\*\.com/);
  } finally {
    repo.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// A private hub with a child, linked from a public page, with a secret on it.
function addPrivatePages(root) {
  write(root, "docs/wiki/salaries.md", `---\ntitle: Salary notes\nparent: home\nprivate: true\ncode: [src/object_detection/**]\n---\n\n# Salary notes\n\nOnly for us. Ask jane.doe@gmail.com. See [the sheet](salary-sheet.md).\n`);
  write(root, "docs/wiki/salary-sheet.md", `---\ntitle: Salary sheet\nparent: salaries\n---\n\n# Salary sheet\n\nRows live elsewhere.\n`);
  const senses = path.join(root, "docs/wiki/senses.md");
  fs.writeFileSync(senses, fs.readFileSync(senses, "utf8") + "\nBudget talk is in [Salary notes](salaries.md#top), not here.\n");
}

test("private pages: in the local site, marked; never in the published build, its links, search or team data", async () => {
  const repo = makeRepo({ generic: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-out-"));
  try {
    addPrivatePages(repo.root);
    write(repo.root, "docs/hypatia.yml", "people:\n  - github: ana-gh\n    past: [salaries, senses]\n");

    const local = await buildGraph({ root: repo.root, token: null, warn: () => {} });
    const ids = local.nodes.map((n) => n.id);
    assert.ok(ids.includes("salaries") && ids.includes("salary-sheet"));
    assert.strictEqual(local.nodes.find((n) => n.id === "salaries").private, true);
    assert.strictEqual(local.nodes.find((n) => n.id === "salary-sheet").private, true, "a page under a private page is private too");
    assert.strictEqual(local.nodes.find((n) => n.id === "senses").private, undefined);

    const warnings = [];
    const excluded = [];
    const pub = await buildGraph({ root: repo.root, token: null, publish: true, excluded, warn: (m) => warnings.push(m) });
    assert.deepStrictEqual(excluded.map((e) => e.id).sort(), ["salaries", "salary-sheet"]);
    assert.deepStrictEqual(warnings, [], "a person's private past page is dropped quietly");
    const senses = pub.nodes.find((n) => n.id === "senses");
    assert.match(senses.markdown, /Budget talk is in Salary notes, not here\./, "the link became plain text");

    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    const build = spawnSync(process.execPath, [CLI, "build", "--out", out], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(build.status, 0, build.stderr);
    for (const file of ["graph.json", "graph.js"]) {
      const text = fs.readFileSync(path.join(out, file), "utf8");
      // (the public page keeps the words its author wrote, "Salary notes", as plain text)
      assert.doesNotMatch(text, /salaries|salary-sheet|Salary sheet|Only for us|jane\.doe/, `${file} never names or shows the private pages`);
    }
    const g = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
    assert.ok(g.nodes.every((n) => !n.private));
    assert.ok(g.people.every((p) => !p.past.includes("salaries") && !p.worked_on.includes("salaries")));

    const check = spawnSync(process.execPath, [CLI, "check"], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(check.status, 0, check.stderr);
    assert.match(check.stdout, /2 private pages left out, no personal data or keys found/);
    assert.match(check.stderr, /private pages \(never published\) mention:\n  docs\/wiki\/salaries\.md:10: email address j\*\*\*@g\*\*\*\.com/);
  } finally {
    repo.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

test("local serve: still runs with a seeded page, and hands the warning to the browser", async () => {
  const repo = makeRepo({ generic: true });
  const logs = [];
  try {
    write(repo.root, "docs/wiki/payments.md", SEEDED);
    addPrivatePages(repo.root);
    const builder = createBuilder({ root: repo.root, token: null, repo: null, log: (m) => logs.push(m) });
    const first = await builder.build("start");
    assert.ok(first.ok, "the local site still builds");
    assert.ok(builder.graph().nodes.some((n) => n.id === "payments"));
    const hits = builder.privacy();
    assert.deepStrictEqual(
      hits.map((h) => `${h.file}:${h.line} ${h.kind}${h.private ? " (private)" : ""}`),
      ["docs/wiki/payments.md:8 email address", "docs/wiki/payments.md:10 Stripe secret key", "docs/wiki/salaries.md:10 email address (private)"]
    );
    assert.ok(hits.every((h) => !("value" in h)), "raw values never leave the scanner");
    assert.match(logs.join("\n"), /Privacy guard: the website build would refuse this wiki \(the local site still works\)/);

    const s = createServer({ graph: builder.graph, privacy: builder.privacy });
    await new Promise((res) => s.server.listen(0, "127.0.0.1", res));
    try {
      const port = s.server.address().port;
      const res = await get(port, "/__hypatia/privacy");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(JSON.parse(res.body).length, 3);
      assert.doesNotMatch(res.body, /jane\.doe|Zq7Zq7/);
      const reload = await get(port, "/__hypatia/reload.js");
      assert.match(reload.body, /fetch\("\/__hypatia\/privacy"\)[\s\S]*the website build/, "the page shows the findings");
    } finally {
      s.server.close();
    }
  } finally {
    repo.cleanup();
  }
});
