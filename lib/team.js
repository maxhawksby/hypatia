// The team: who shows up in the People list, with a name, a color and a
// focus line.
//
// Nobody has to write a team file. People come from:
// - git history: every commit author (bots left out), with the identities of
//   one person (two emails, a GitHub "noreply" address) joined together;
// - GitHub, only with a token: the login behind each author, and the repo's
//   collaborators (those with no commits yet too). A token without the right
//   permission, or no token, just means less is known; the build never stops.
//
// Each person gets a color from PALETTE, chosen from their id, so the same
// person keeps the same color every build.
//
// One optional config file overrides it all (see CONFIG_FILES and parseConfig):
// the site title, names, colors, focus lines, people to leave out, or a fixed
// list of people.
"use strict";

const fs = require("fs");
const path = require("path");
const { splitlines, stripChars, splitMax, parseValue, readText, slugify, cmp } = require("./text");
const { getAll, getOne, notAllowed } = require("./github");

// Where the config is read from, first one found wins. docs/team.yml is the
// older name (a team list only); a fixed list there is the whole team.
const CONFIG_FILES = ["docs/hypatia.yml", "docs/team.yml"];

// Bright colors that read well on the site's dark background (contrast 4.5:1
// or more against it) and are clearly not grey or white: grey means "nobody".
const PALETTE = [
  "#ff8787", // red
  "#ffa94d", // orange
  "#ffd43b", // yellow
  "#a9e34b", // lime
  "#69db7c", // green
  "#38d9a9", // teal
  "#3bc9db", // cyan
  "#4dabf7", // blue
  "#91a7ff", // indigo
  "#b197fc", // violet
  "#e599f7", // grape
  "#f783ac", // pink
];

const DISCORD_ID = /^\d{17,20}$/;

const GITHUB_LOOKUPS = 40; // most commits looked up on GitHub per build, to find logins

// ---------------------------------------------------------------- config

// Read the config file's text:
//
//   title: My project          # the site title (default: README's first heading)
//   only_listed: false         # true: the people below are the whole team
//   exclude: [dependabot, Old Intern]   # logins, ids or names to leave out
//   people:
//     - github: ana-gh         # matched by github login, id or name
//       id: ana                # optional, used in links (#people/ana)
//       name: Ana
//       color: "#ff4d5e"
//       focus: Object detection
//       past: [object-detection]   # pages they worked on that git may not show
//       discord_id: "123456789012345678"   # optional: lets a chat ping @mention them
//   allow: [support@acme.dev, "sk_test_*"]   # values the privacy guard may publish
//   drift: warn                # off | warn | error: pages whose code changed since their
//                              # verified: stamp are listed (warn) or fail the check (error)
//   coverage: [src]            # every top-level folder in these needs a page
//
// Lists are [a, b] or one "- item" per line. Unknown keys are ignored.
function parseConfig(text, { legacy = false, warn = () => {} } = {}) {
  const fields = Object.create(null);
  const peopleLines = [];
  let section = null; // "people", or a key whose "- item" list follows
  for (const raw of splitlines(text)) {
    const line = raw.trimStart().startsWith("#") ? "" : raw.split(" #")[0].trimEnd();
    if (!line.trim()) continue;
    const top = !/^\s/.test(line) && !(section === "people" && line.startsWith("-"));
    if (top) {
      section = null;
      if (!line.includes(":")) continue;
      const [key, value] = splitMax(line, ":", 1);
      const k = key.trim();
      if (k === "people") section = "people";
      else if (!value.trim()) {
        section = k;
        fields[k] = [];
      } else fields[k] = parseValue(value);
    } else if (section === "people") peopleLines.push(line);
    else if (section && /^-(\s|$)/.test(line.trim())) {
      const item = stripChars(line.trim().slice(1).trim(), "'\"");
      if (item) fields[section].push(item);
    }
  }
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const flag = (v) => (typeof v === "string" && /^(true|yes|on)$/i.test(v) ? true : typeof v === "string" && /^(false|no|off)$/i.test(v) ? false : null);
  const onlyListed = flag(fields.only_listed);
  if (typeof fields.drift === "string" && fields.drift.trim() && driftMode(fields.drift) === "off" && !/^(off|false|no)$/i.test(fields.drift.trim())) {
    warn(`drift: "${fields.drift}" is not a drift setting; use off, warn or error. Treating it as off.`);
  }
  return {
    title: typeof fields.title === "string" ? fields.title : "",
    onlyListed: onlyListed === null ? legacy : onlyListed,
    exclude: list(fields.exclude),
    allow: list(fields.allow),
    drift: driftMode(fields.drift),
    // the older switch as written ("true", "yes", "on"), or ""
    driftLegacy: typeof fields.drift === "string" && /^(true|yes|on)$/i.test(fields.drift.trim()) ? fields.drift.trim() : "",
    coverage: list(fields.coverage),
    people: parsePeople(peopleLines.join("\n")),
  };
}

// The drift setting as "off", "warn" or "error". The older on/off switch:
// true/yes/on mean warn (an older repo has no stamps yet, so failing would
// block every pull request; only an explicit "error" fails) and false/no
// mean off. Missing or unknown means off.
function driftMode(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "warn" || v === "error" || v === "off") return v;
  if (/^(true|yes|on)$/.test(v)) return "warn";
  return "off";
}

// The 'people:' list: one '- key: value' block per person.
function parsePeople(text) {
  const people = [];
  let cur = null;
  for (const raw of splitlines(text)) {
    let stripped = raw.trim();
    if (!stripped) continue;
    if (stripped.startsWith("- ") || stripped === "-") {
      cur = Object.create(null);
      people.push(cur);
      stripped = stripped.slice(1).trim();
    }
    if (cur === null || !stripped.includes(":")) continue;
    const [key, value] = splitMax(stripped, ":", 1);
    cur[key.trim()] = parseValue(value);
  }
  const out = [];
  for (const p of people) {
    const rec = {};
    for (const f of ["id", "name", "github", "color", "focus", "discord_id"]) rec[f] = typeof p[f] === "string" ? p[f] : "";
    if (!rec.id && !rec.github && !rec.name) continue; // nobody to match
    const past = "past" in p ? p.past : [];
    rec.past = Array.isArray(past) ? past : past ? [past] : [];
    out.push(rec);
  }
  return out;
}

// The config for the repo at root, or an empty one. warn() hears about
// values that are ignored.
function loadConfig(root, warn = () => {}) {
  for (const rel of CONFIG_FILES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const config = parseConfig(readText(file), { legacy: rel.endsWith("team.yml"), warn: (msg) => warn(`${rel}: ${msg}`) });
    for (const p of config.people) {
      if (p.color && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(p.color)) {
        warn(`${rel}: ${p.id || p.github || p.name} has color "${p.color}"; use a hex color like "#4dabf7". Picking one instead.`);
        p.color = "";
      }
      // a chat id is published on the site, so only a real Discord user id
      // (a 17 to 20 digit number) goes through, never a name or a typo
      if (p.discord_id && !DISCORD_ID.test(p.discord_id)) {
        warn(`${rel}: ${p.id || p.github || p.name} has discord_id "${p.discord_id}"; use the numeric user id (17 to 20 digits). Leaving it out.`);
        p.discord_id = "";
      }
    }
    return { file: rel, ...config };
  }
  return { file: null, title: "", onlyListed: false, exclude: [], allow: [], drift: "off", driftLegacy: "", coverage: [], people: [] };
}

// ---------------------------------------------------------------- git

// The login in a GitHub "noreply" commit email, or null.
function noreplyLogin(email) {
  const m = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email || "");
  return m ? m[1] : null;
}

// Commits by tools, not people: "[bot]" accounts, GitHub Actions and
// no-reply senders other than GitHub's per-person ones.
function isBot({ name = "", email = "", login = "" } = {}) {
  if (/\[bot\]$/i.test(name) || /\[bot\]/i.test(email) || /\[bot\]$/i.test(login || "")) return true;
  if (/^github-actions\b/i.test(name) || /^actions?@github\.com$/i.test(email)) return true;
  return /^no-?reply@/i.test(email) && !/@users\.noreply\.github\.com$/i.test(email);
}

// One record per author email: {email, name, names, count, first, sha}.
// commits: newest first, as gitCommits gives them. first = oldest commit
// date (ms), sha = the oldest commit (the one most likely on GitHub).
function gitIdentities(commits) {
  const byEmail = new Map();
  for (const c of commits) {
    const email = (c.email || "").trim().toLowerCase();
    const name = (c.author || "").trim();
    if (!email && !name) continue;
    if (isBot({ name, email })) continue;
    const key = email || "name:" + name.toLowerCase();
    let id = byEmail.get(key);
    if (!id) {
      id = { email, login: noreplyLogin(c.email), name, names: new Map(), count: 0, first: Infinity, sha: null };
      byEmail.set(key, id);
    }
    id.count++;
    id.names.set(name, (id.names.get(name) || 0) + 1);
    const t = Date.parse(c.date);
    if (!Number.isNaN(t) && t <= id.first) {
      id.first = t;
      id.sha = c.sha;
    }
  }
  for (const id of byEmail.values()) {
    // the name used most, the newest on a tie (names are seen newest first)
    id.name = [...id.names].sort((a, b) => b[1] - a[1])[0][0];
  }
  return [...byEmail.values()];
}

const lower = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

// "Max Hawksby" and "Maxwell Hawksby": same last name, and one first name
// starts the other (3 letters or more).
function sameShortName(a, b) {
  const wa = lower(a).split(" ");
  const wb = lower(b).split(" ");
  if (wa.length < 2 || wb.length < 2 || wa[wa.length - 1] !== wb[wb.length - 1]) return false;
  const [x, y] = [wa[0], wb[0]].sort((p, q) => p.length - q.length);
  return x.length >= 3 && y.startsWith(x);
}

// Join the identities of one person: same GitHub login, same name, a name
// that is someone's login, or the same short and long first name. Returns
// people (without colors), most commits first.
//   loginByEmail: email -> login, from GitHub (may be empty)
function groupIdentities(identities, loginByEmail = new Map()) {
  const ids = identities.map((x) => ({ ...x, login: x.login || loginByEmail.get(x.email) || null }));
  const parent = ids.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const seen = new Map(); // "login:x" / "name:x" -> first index
  const join = (key, i) => (seen.has(key) ? union(seen.get(key), i) : seen.set(key, i));
  ids.forEach((x, i) => {
    if (x.login) join("login:" + x.login.toLowerCase(), i);
    for (const n of x.names.keys()) if (lower(n)) join("name:" + lower(n), i);
  });
  ids.forEach((x, i) => {
    for (const n of x.names.keys()) if (seen.has("login:" + lower(n))) union(seen.get("login:" + lower(n)), i);
  });
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) if (sameShortName(ids[i].name, ids[j].name)) union(i, j);
  }

  const groups = new Map();
  ids.forEach((x, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(x);
  });
  const people = [];
  for (const members of groups.values()) {
    members.sort((a, b) => b.count - a.count || a.first - b.first);
    const names = new Map();
    for (const m of members) for (const [n, c] of m.names) names.set(n, (names.get(n) || 0) + c);
    const ranked = [...names].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const github = (members.find((m) => m.login) || {}).login || "";
    // a real name ("Ana Lopez"), else the GitHub login (GitHub may know the
    // real name), else the name used most
    const name = ranked.find((n) => /\s/.test(n.trim())) || github || ranked[0];
    people.push({
      id: "",
      name,
      github,
      color: "",
      focus: "",
      past: [],
      commits: members.reduce((s, m) => s + m.count, 0),
      first: Math.min(...members.map((m) => m.first)),
      emails: new Set(members.map((m) => m.email).filter(Boolean)),
      names: new Set(ranked.map(lower)),
      shas: members.filter((m) => !m.login && m.sha).map((m) => [m.email, m.sha]),
    });
  }
  people.sort((a, b) => b.commits - a.commits || cmp(lower(a.name), lower(b.name)));
  giveIds(people);
  return people;
}

// Ids from names ("Ana Lopez" -> ana-lopez), never from GitHub data, so they
// stay the same with or without a token. Clashes get -2, -3 by seniority.
function giveIds(people, taken = new Set()) {
  const order = people.slice().sort((a, b) => a.first - b.first || cmp(lower(a.name), lower(b.name)));
  for (const p of order) {
    if (p.id) continue;
    const base = slugify(p.name) || slugify(p.github) || "person";
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    p.id = id;
    taken.add(id);
  }
}

// ---------------------------------------------------------------- GitHub

// What GitHub adds, cached across rebuilds of `hypatia serve`.
const shaLogins = new Map(); // "repo@sha" -> login or null
const profileNames = new Map(); // login -> name or null

async function inPool(items, size, fn) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// { loginByEmail, collaborators: [login], profile: login -> name }.
// Each part is skipped when the token may not read it.
async function githubTeam(ctx, people) {
  const { token, repo } = ctx;
  const out = { loginByEmail: new Map(), collaborators: [], profile: new Map() };
  if (!token || !repo) return out;
  let failed = null;
  const soft = (err) => {
    if (!notAllowed(err)) failed = failed || err;
  };

  // The login behind authors whose email does not say it: GitHub links a
  // commit to the account that owns its email.
  const lookups = people.flatMap((p) => p.shas).slice(0, GITHUB_LOOKUPS);
  await inPool(lookups, 6, async ([email, sha]) => {
    const key = `${repo}@${sha}`;
    if (!shaLogins.has(key)) {
      try {
        const c = await getOne(token, `repos/${repo}/commits/${sha}`);
        shaLogins.set(key, (c.author && c.author.login) || null);
      } catch (err) {
        soft(err);
        if (notAllowed(err)) shaLogins.set(key, null); // e.g. a commit never pushed
        return;
      }
    }
    if (shaLogins.get(key)) out.loginByEmail.set(email, shaLogins.get(key));
  });

  // Collaborators: needs push access to the repo; without it, skipped.
  try {
    const list = await getAll(token, repo, "collaborators?per_page=100");
    out.collaborators = list.filter((u) => u && u.login && u.type !== "Bot" && !isBot({ login: u.login })).map((u) => u.login);
  } catch (err) {
    soft(err);
  }
  if (failed) ctx.warn(`could not read the whole team from GitHub (${failed.message}); using git history for the rest.`);
  return out;
}

// Real names for people known only by their login.
async function profileNamesFor(ctx, logins) {
  const todo = logins.filter((l) => !profileNames.has(l.toLowerCase())).slice(0, GITHUB_LOOKUPS);
  await inPool(todo, 6, async (login) => {
    try {
      const u = await getOne(ctx.token, `users/${encodeURIComponent(login)}`);
      profileNames.set(login.toLowerCase(), (u.name || "").trim() || null);
    } catch (err) {
      if (notAllowed(err)) profileNames.set(login.toLowerCase(), null);
    }
  });
}

// ---------------------------------------------------------------- the team

// Does config entry e mean auto person a? stage: "github", "id" or "name".
function entryMatches(e, a, stage) {
  if (stage === "github") return !!e.github && (lower(a.github) === lower(e.github) || a.names.has(lower(e.github)));
  if (stage === "id") return !!e.id && (a.id === e.id || lower(a.github) === lower(e.id) || a.names.has(lower(e.id)));
  if (!e.name) return false;
  const n = lower(e.name);
  return a.names.has(n) || [...a.names].some((x) => x.split(" ")[0] === n);
}

// Hash a string to a palette slot (FNV-1a).
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Fill in missing colors. Each person starts at the slot their id hashes to
// and takes the next free one; people are seated by seniority (first commit),
// so someone new never takes an existing teammate's color. Colors from the
// config are kept and their slots skipped. With more people than colors,
// colors repeat.
function assignColors(people) {
  const taken = new Set(people.filter((p) => p.color).map((p) => p.color.toLowerCase()));
  const order = people.filter((p) => !p.color).sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity) || cmp(a.id, b.id));
  for (const p of order) {
    const start = hash(p.id) % PALETTE.length;
    let color = PALETTE[start];
    for (let i = 0; i < PALETTE.length; i++) {
      const c = PALETTE[(start + i) % PALETTE.length];
      if (!taken.has(c)) {
        color = c;
        break;
      }
    }
    taken.add(color);
    p.color = color;
  }
  return people;
}

// The final list: config entries first (in their order), merged with the
// person git or GitHub knows them as, then everyone else unless only_listed.
function resolveTeam(config, auto) {
  const used = new Set();
  const ids = new Set();
  const listed = config.people.map((e) => {
    let match = null;
    for (const stage of ["github", "id", "name"]) {
      match = auto.find((a) => !used.has(a) && entryMatches(e, a, stage));
      if (match) break;
    }
    if (match) used.add(match);
    const m = match || {};
    // the config's id, else one from the name it gives, else the usual one
    let id = e.id || slugify(e.name) || m.id || slugify(e.github) || "person";
    for (let n = 2; ids.has(id); n++) id = `${e.id || slugify(e.name) || m.id || "person"}-${n}`;
    ids.add(id);
    return {
      id,
      name: e.name || m.name || e.github || e.id,
      github: e.github || m.github || "",
      color: e.color || "",
      focus: e.focus || "",
      ...(e.discord_id ? { discord_id: e.discord_id } : {}),
      past: e.past.slice(),
      commits: m.commits || 0,
      first: m.first ?? Infinity,
      emails: m.emails || new Set(),
      names: new Set([...(m.names || []), lower(e.name)].filter(Boolean)),
    };
  });
  const rest = config.onlyListed ? [] : auto.filter((a) => !used.has(a));
  // an auto id that a listed person already uses gets a new one
  for (const p of rest) {
    if (ids.has(p.id)) p.id = "";
  }
  giveIds(rest, ids);
  const out = listed.concat(rest);
  const drop = new Set(config.exclude.map(lower));
  const kept = out.filter((p) => ![p.id, p.github, p.name, ...p.names].some((x) => x && drop.has(lower(x))));
  return assignColors(kept);
}

// The team for a build. commits: every commit on every branch, newest first.
async function buildTeam(ctx, commits, config) {
  const identities = gitIdentities(commits);
  let auto = groupIdentities(identities);
  if (ctx.token && ctx.repo) {
    const gh = await githubTeam(ctx, auto);
    if (gh.loginByEmail.size) auto = groupIdentities(identities, gh.loginByEmail);
    for (const login of gh.collaborators) {
      const l = login.toLowerCase();
      if (auto.some((a) => lower(a.github) === l || a.names.has(l))) continue;
      auto.push({ id: "", name: login, github: login, color: "", focus: "", past: [], commits: 0, first: Infinity,
        emails: new Set(), names: new Set([l]), shas: [] });
    }
    // a login used as the name: ask GitHub for the real one
    const bare = auto.filter((a) => a.github && lower(a.name) === lower(a.github)).map((a) => a.github);
    if (bare.length) {
      await profileNamesFor(ctx, bare);
      for (const a of auto) {
        const real = a.github && lower(a.name) === lower(a.github) ? profileNames.get(a.github.toLowerCase()) : null;
        if (real) {
          a.name = real;
          a.names.add(lower(real));
        }
      }
    }
    giveIds(auto, new Set(auto.map((a) => a.id).filter(Boolean)));
  }
  return resolveTeam(config, auto);
}

// Team id for a GitHub login, a git author name or email, else null.
function matchPerson(people, { login = null, name = null, email = null } = {}) {
  if (email) login = login || noreplyLogin(email);
  if (login) {
    for (const p of people) if (p.github && p.github.toLowerCase() === login.toLowerCase()) return p.id;
  }
  if (email) {
    const e = email.trim().toLowerCase();
    for (const p of people) if (p.emails && p.emails.has(e)) return p.id;
  }
  if (name) {
    const n = lower(name);
    const words = n.split(" ").filter(Boolean);
    const first = words.length ? words[0] : "";
    for (const p of people) if ([lower(p.github), lower(p.name), p.id].includes(n) || (p.names && p.names.has(n))) return p.id;
    for (const p of people) if (first && first === lower(p.name)) return p.id;
  }
  return null;
}

// What goes into graph.json for a person: never their email. A chat id only
// when they put it in the config, so a ping can @mention them.
function publicPerson(p) {
  return { id: p.id, name: p.name, github: p.github, color: p.color, focus: p.focus, past: p.past, ...(p.discord_id ? { discord_id: p.discord_id } : {}) };
}

module.exports = {
  driftMode,
  CONFIG_FILES,
  PALETTE,
  parseConfig,
  loadConfig,
  isBot,
  noreplyLogin,
  gitIdentities,
  groupIdentities,
  resolveTeam,
  assignColors,
  buildTeam,
  matchPerson,
  publicPerson,
};
