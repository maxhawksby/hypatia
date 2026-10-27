// Tests for the team (lib/team.js): people from git and GitHub, stable
// colors and the config file that overrides them. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const team = require("../lib/team");
const bg = require("../lib/build-graph");
const { makeRepo, write, commit, git } = require("./helpers");

const day = (n) => `2026-0${1 + Math.floor(n / 28)}-${String(1 + (n % 28)).padStart(2, "0")}T10:00:00Z`;
// commits newest first, as git log gives them
const log = (...rows) => rows.map(([author, email, n], i) => ({ sha: "sha" + i, author, email, date: day(n), message: "m", files: [] })).reverse();

const COMMITS = log(
  ["Max Hawksby", "max@example.com", 1],
  ["Maxwell Hawksby", "162082966+max-gh@users.noreply.github.com", 2],
  ["SamR23", "4242+SamRivera9@users.noreply.github.com", 3],
  ["SamRivera9", "4242+SamRivera9@users.noreply.github.com", 4],
  ["jevgome", "jev@example.com", 5],
  ["dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com", 6],
  ["Claude", "noreply@anthropic.com", 7],
  ["github-actions", "41898282+github-actions[bot]@users.noreply.github.com", 8],
  ["Max Hawksby", "max@example.com", 9]
);
const NO_CONFIG = { title: "", onlyListed: false, exclude: [], people: [] };

// ---------------------------------------------------------------- from git

test("team from git: one person per author, identities joined, bots left out", () => {
  const people = team.groupIdentities(team.gitIdentities(COMMITS));
  const got = people.map((p) => [p.id, p.name, p.github, p.commits]);
  assert.deepStrictEqual(got, [
    ["max-hawksby", "Max Hawksby", "max-gh", 3], // two names, two emails, one person
    ["samrivera9", "SamRivera9", "SamRivera9", 2], // the noreply email gives the login, used as the name
    ["jevgome", "jevgome", "", 1],
  ]);
});

test("bots and no-reply senders are not people", () => {
  assert.ok(team.isBot({ name: "renovate[bot]", email: "x@y.z" }));
  assert.ok(team.isBot({ name: "Claude", email: "noreply@anthropic.com" }));
  assert.ok(team.isBot({ name: "GitHub Action", email: "action@github.com" }));
  assert.ok(!team.isBot({ name: "Ana", email: "1+ana@users.noreply.github.com" }));
  assert.ok(!team.isBot({ name: "Ana", email: "ana@example.com" }));
});

test("a login GitHub knows joins an author to their other identity", () => {
  const ids = team.gitIdentities(log(["Ana Lopez", "ana@work.example", 1], ["ana-gh", "1+ana-gh@users.noreply.github.com", 2]));
  assert.strictEqual(team.groupIdentities(ids).length, 2);
  const joined = team.groupIdentities(ids, new Map([["ana@work.example", "ana-gh"]]));
  assert.deepStrictEqual(joined.map((p) => [p.id, p.name, p.github]), [["ana-lopez", "Ana Lopez", "ana-gh"]]);
});

test("people from git get ids that do not depend on GitHub", () => {
  const ids = team.gitIdentities(log(["Ana Lopez", "ana@work.example", 1]));
  assert.strictEqual(team.groupIdentities(ids)[0].id, team.groupIdentities(ids, new Map([["ana@work.example", "ana-gh"]]))[0].id);
});

// ---------------------------------------------------------------- colors

// WCAG contrast of two #rrggbb colors.
function contrast(a, b) {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function saturation(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

test("palette: every color reads on the dark backgrounds and is clearly not grey or white", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "site", "style.css"), "utf8");
  const backgrounds = ["--bg", "--bg-side", "--bg-map"].map((v) => new RegExp(`${v}:\\s*(#[0-9a-f]{6})`, "i").exec(css)[1]);
  assert.ok(team.PALETTE.length >= 10);
  assert.strictEqual(new Set(team.PALETTE).size, team.PALETTE.length);
  for (const c of team.PALETTE) {
    for (const bgc of backgrounds) assert.ok(contrast(c, bgc) >= 4.5, `${c} on ${bgc}: ${contrast(c, bgc).toFixed(2)}`);
    assert.ok(saturation(c) >= 0.6, `${c} looks grey`);
    assert.ok(contrast(c, "#ffffff") >= 1.3, `${c} is almost white`);
  }
});

const person = (id, first) => ({ id, name: id, color: "", first });

test("colors: the same person gets the same color every build", () => {
  const a = team.assignColors([person("ana", 1), person("ben", 2), person("cy", 3)]).map((p) => p.color);
  const b = team.assignColors([person("cy", 3), person("ana", 1), person("ben", 2)]).map((p) => p.color);
  assert.deepStrictEqual(b, [a[2], a[0], a[1]]);
  assert.ok(a.every((c) => team.PALETTE.includes(c)));
});

test("colors: no two people share one while colors last, and a newcomer never takes a teammate's", () => {
  const twelve = Array.from({ length: team.PALETTE.length }, (_, i) => person("p" + i, i));
  const colors = team.assignColors(twelve.map((p) => ({ ...p }))).map((p) => p.color);
  assert.strictEqual(new Set(colors).size, team.PALETTE.length);
  const before = team.assignColors(twelve.slice(0, 5).map((p) => ({ ...p }))).map((p) => p.color);
  const after = team.assignColors(twelve.slice(0, 6).map((p) => ({ ...p }))).map((p) => p.color);
  assert.deepStrictEqual(after.slice(0, 5), before);
});

test("colors: a color from the config is kept and nobody else gets it", () => {
  const got = team.assignColors([{ ...person("ana", 1), color: team.PALETTE[0] }, ...Array.from({ length: 11 }, (_, i) => person("p" + i, i + 2))]);
  assert.strictEqual(got[0].color, team.PALETTE[0]);
  assert.ok(got.slice(1).every((p) => p.color !== team.PALETTE[0]));
});

// ---------------------------------------------------------------- config

const CONFIG = `\
title: Acme   # the site title
exclude: [jevgome]
people:
  - github: SamRivera9
    name: Sam
    color: "#b5e61d"
    focus: Auto mapper
  - id: max
    name: Max
    past: [maps]
  - name: Robin
    focus: Joins next week
`;

test("config: title, exclude list and people", () => {
  const c = team.parseConfig(CONFIG);
  assert.deepStrictEqual([c.title, c.onlyListed, c.exclude], ["Acme", false, ["jevgome"]]);
  assert.deepStrictEqual(c.people.map((p) => [p.id, p.name, p.github, p.color, p.past]), [
    ["", "Sam", "SamRivera9", "#b5e61d", []],
    ["max", "Max", "", "", ["maps"]],
    ["", "Robin", "", "", []],
  ]);
  const block = team.parseConfig("exclude:\n  - old-intern\n  - 'Some Bot'\nonly_listed: yes\npeople:\n- id: a\n  name: A\n");
  assert.deepStrictEqual([block.exclude, block.onlyListed, block.people.map((p) => p.id)], [["old-intern", "Some Bot"], true, ["a"]]);
});

test("config: overrides names, colors and focus, leaves people out, and keeps everyone else", () => {
  const auto = team.groupIdentities(team.gitIdentities(COMMITS));
  const people = team.resolveTeam(team.parseConfig(CONFIG), auto);
  const by = Object.fromEntries(people.map((p) => [p.id, p]));
  assert.deepStrictEqual(people.map((p) => p.id), ["sam", "max", "robin"]); // config order; jevgome excluded
  assert.deepStrictEqual([by.sam.name, by.sam.github, by.sam.color, by.sam.focus], ["Sam", "SamRivera9", "#b5e61d", "Auto mapper"]);
  assert.deepStrictEqual([by.max.github, by.max.past], ["max-gh", ["maps"]]); // matched by first name, login from git
  assert.strictEqual(by.robin.commits, 0); // listed, no commits yet: still on the team
  assert.ok(team.PALETTE.includes(by.max.color) && team.PALETTE.includes(by.robin.color));
  assert.strictEqual(team.matchPerson(people, { name: "Maxwell Hawksby", email: "max@example.com" }), "max"); // by email
});

test("config: only_listed keeps just the listed people; the older docs/team.yml works that way", () => {
  const auto = team.groupIdentities(team.gitIdentities(COMMITS));
  const listed = team.resolveTeam(team.parseConfig("only_listed: true\npeople:\n  - id: max\n    name: Max\n"), auto);
  assert.deepStrictEqual(listed.map((p) => p.id), ["max"]);
  assert.strictEqual(team.parseConfig("people:\n  - id: a\n", { legacy: true }).onlyListed, true);
  assert.strictEqual(team.parseConfig("only_listed: false\npeople:\n  - id: a\n", { legacy: true }).onlyListed, false);
  assert.deepStrictEqual(team.resolveTeam(NO_CONFIG, auto).map((p) => p.id), ["max-hawksby", "samrivera9", "jevgome"]);
});

test("config: docs/hypatia.yml wins over docs/team.yml, and a bad color is replaced", () =>
  withRepo({ generic: true }, (root) => {
    write(root, "docs/team.yml", "people:\n  - id: old\n");
    assert.strictEqual(team.loadConfig(root).file, "docs/team.yml");
    write(root, "docs/hypatia.yml", "people:\n  - id: ana\n    color: red\n");
    const warnings = [];
    const c = team.loadConfig(root, (m) => warnings.push(m));
    assert.deepStrictEqual([c.file, c.people[0].color], ["docs/hypatia.yml", ""]);
    assert.match(warnings[0], /use a hex color/);
  }));

// ---------------------------------------------------------------- whole builds

async function withRepo(opts, fn) {
  const repo = makeRepo(opts);
  try {
    return await fn(repo.root);
  } finally {
    repo.cleanup();
  }
}
const build = (root, extra) => bg.buildGraph({ root, env: {}, warn: () => {}, ...extra });

test("a repo with no team file: the people come from git, with colors, and the title from README", () =>
  withRepo({ generic: true }, async (root) => {
    const g = await build(root);
    assert.deepStrictEqual([g.title, g.center], ["Acme Notes", "acme-notes"]);
    assert.strictEqual(g.nodes[0].id, "acme-notes"); // hubs say "parent: home"
    assert.deepStrictEqual(g.people.map((p) => [p.id, p.name, p.github]).sort(), [
      ["ana-lopez", "Ana Lopez", "ana-gh"],
      ["ben-carter", "Ben Carter", ""],
      ["stranger", "Stranger", ""],
    ]);
    assert.ok(g.people.every((p) => team.PALETTE.includes(p.color)));
    assert.strictEqual(new Set(g.people.map((p) => p.color)).size, 3);
    assert.ok(!JSON.stringify(g.people).includes("@"), "no emails in the site data");
    const ana = g.people.find((p) => p.id === "ana-lopez");
    assert.ok(ana.contributed.includes("object-detection"));
    assert.strictEqual(g.branches[0].person, "ana-lopez");
    // the same colors next build, and after a newcomer commits
    const again = await build(root);
    assert.deepStrictEqual(again.people.map((p) => p.color), g.people.map((p) => p.color));
    write(root, "x.txt", "x\n");
    commit(root, { name: "Newcomer", email: "new@example.com" }, "Hello");
    const later = await build(root);
    for (const p of g.people) assert.strictEqual(later.people.find((q) => q.id === p.id).color, p.color);
  }));

test("a config file next to git people: overrides apply, the rest stay", () =>
  withRepo({ generic: true }, async (root) => {
    write(root, "docs/hypatia.yml", `title: Notes\nexclude: [Stranger]\npeople:\n  - github: ana-gh\n    id: ana\n    name: Ana\n    color: "#123456"\n    focus: Boxes\n`);
    const g = await build(root);
    assert.strictEqual(g.title, "Notes");
    assert.deepStrictEqual(g.people.map((p) => [p.id, p.name, p.color === "#123456", p.focus]), [
      ["ana", "Ana", true, "Boxes"],
      ["ben-carter", "Ben Carter", false, ""],
    ]);
    assert.strictEqual(g.recent.find((r) => r.message === "Keyboard teleop: arrow keys").person, "ben-carter");
  }));

test("README title: first heading as plain text, else the repo name", () => {
  assert.strictEqual(bg.readmeTitle("[![badge](b.svg)](x)\n\n# The **Notes** [app](x) `v2`\n"), "The Notes app v2");
  assert.strictEqual(bg.readmeTitle("# ![logo](l.png)\n\nNotes App\n=====\n"), "Notes App");
  assert.strictEqual(bg.readmeTitle('<h1 align="center">Notes</h1>\n'), "Notes");
  assert.strictEqual(bg.readmeTitle("```\n# not a title\n```\nno heading"), "");
  return withRepo({ generic: true }, async (root) => {
    fs.writeFileSync(path.join(root, "README.md"), "No heading here.\n");
    const g = await build(root);
    assert.deepStrictEqual([g.title, g.center], ["notes-app", "notes-app"]);
  });
});

// ---------------------------------------------------------------- GitHub

// Stands in for GitHub: routes are matched by the end of the URL.
function fakeGithub(routes) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const [status, body] = hit ? hit[1] : [404, {}];
    return { ok: status < 300, status, statusText: String(status), headers: new Map(), json: async () => body };
  };
  return { calls, restore: () => (global.fetch = real) };
}

test("GitHub: logins and collaborators join the team when the token may read them", () =>
  withRepo({ generic: true }, async (root) => {
    const benFirst = git(root, ["log", "--format=%H", "--author=Ben", "--reverse"]).split("\n")[0];
    const gh = fakeGithub({
      "/collaborators": [200, [{ login: "ben-gh", type: "User" }, { login: "cara", type: "User" }, { login: "ci-bot[bot]", type: "Bot" }]],
      [`/commits/${benFirst}`]: [200, { author: { login: "ben-gh" } }],
      "/users/cara": [200, { name: "Cara Diaz" }],
      "/issues": [200, []],
      "/pulls": [200, []],
    });
    try {
      const warnings = [];
      const g = await build(root, { token: "t", repo: "acme/notes-app", warn: (m) => warnings.push(m) });
      const by = Object.fromEntries(g.people.map((p) => [p.id, p]));
      assert.strictEqual(by["ben-carter"].github, "ben-gh");
      assert.strictEqual(by["cara-diaz"].github, "cara"); // a collaborator with no commits yet
      assert.ok(!g.people.some((p) => /bot/.test(p.github)));
      assert.deepStrictEqual(warnings, []);
    } finally {
      gh.restore();
    }
  }));

test("GitHub: a token without permission, or GitHub down, still builds the team from git", () =>
  withRepo({ generic: true }, async (root) => {
    const forbidden = fakeGithub({ "/collaborators": [403, {}], "/commits/": [403, {}], "/issues": [200, []], "/pulls": [200, []] });
    try {
      const warnings = [];
      const g = await build(root, { token: "t", repo: "acme/notes-app", warn: (m) => warnings.push(m) });
      assert.strictEqual(g.people.length, 3);
      assert.deepStrictEqual(warnings, [], "no permission is not a problem worth a warning");
    } finally {
      forbidden.restore();
    }
    const real = global.fetch;
    global.fetch = async () => {
      throw new Error("offline");
    };
    try {
      const warnings = [];
      const g = await build(root, { token: "t2", repo: "acme/other", warn: (m) => warnings.push(m) });
      assert.strictEqual(g.people.length, 3);
      assert.ok(warnings.some((w) => /offline/.test(w)));
    } finally {
      global.fetch = real;
    }
  }));

// ---------------------------------------------------------------- legacy

test("an older team file still lists exactly that team, matched to git by name and login", () =>
  withRepo({}, async (root) => {
    const g = await build(root);
    assert.deepStrictEqual(g.people.map((p) => [p.id, p.name, p.color]), [
      ["ana", "Ana", "#ff4d5e"],
      ["ben", "Ben Carter", "#5aa9ff"],
    ]);
  }));
