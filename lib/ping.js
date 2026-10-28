// `hypatia ping`: posts to Discord when a pull request asks for review or
// someone asks a wiki question. Run by the optional wiki-ping workflow in
// GitHub Actions, which hands it the event (GITHUB_EVENT_NAME,
// GITHUB_EVENT_PATH).
//
// It posts:
// - for a pull request that asks for review (opened ready for review,
//   ready_for_review, review_requested): Who, What, Why, Before, After, the
//   wiki pages it touches and the link, read from the description (headings,
//   bold labels or "Why:" lines; "- Before: ... After: ..." bullets work too);
// - for an issue labelled "question": the question, @mentioning the people
//   working on its pages, else whoever changed them last.
//
// Webhooks (repo secrets), first one set wins:
// - reviews:   DISCORD_REVIEW_WEBHOOK_URL, DISCORD_WEBHOOK_URL
// - questions: DISCORD_QUESTIONS_WEBHOOK_URL, DISCORD_REVIEW_WEBHOOK_URL, DISCORD_WEBHOOK_URL
// With none set it says "Discord not set up yet" and passes.
//
// A person is @mentioned when the config gives their discord_id, otherwise
// named. Node built-ins only (fetch, Node 18+).
"use strict";

const fs = require("fs");
const { buildGraph, WikiError } = require("./build-graph");

// GitHub sends "opened" and then "labeled" for labels set at creation, and
// "opened" then "review_requested" for reviewers set at creation. A second
// event this soon after creation is that echo, so it is skipped.
const ECHO_SECONDS = 60;
const WEBHOOKS = {
  review: ["DISCORD_REVIEW_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"],
  question: ["DISCORD_QUESTIONS_WEBHOOK_URL", "DISCORD_REVIEW_WEBHOOK_URL", "DISCORD_WEBHOOK_URL"],
};
const NOT_FILLED = "not filled in";

const when = (text) => {
  const t = Date.parse(text || "");
  return Number.isNaN(t) ? null : t;
};
const labels = (item) => (item.labels || []).map((l) => l.name || "");
const isEcho = (item) => {
  const made = when(item.created_at);
  const now = when(item.updated_at);
  return made !== null && now !== null && (now - made) / 1000 < ECHO_SECONDS;
};

function pagesFromLabels(item, graph) {
  const known = new Set((graph.nodes || []).map((n) => n.id));
  return labels(item).filter((n) => n.startsWith("wiki:") && known.has(n.slice(5))).map((n) => n.slice(5));
}

function personBy(graph, { id = null, login = null } = {}) {
  return (graph.people || []).find((p) => (id && p.id === id) || (login && (p.github || "").toLowerCase() === login.toLowerCase())) || null;
}

function mention(person, fallback = "") {
  if (person && person.discord_id) return `<@${person.discord_id}>`;
  if (person) return person.name || person.id;
  return fallback;
}

// Team ids who own these pages: open work on them, else the last changer.
function owners(graph, pages, exclude = new Set()) {
  const out = [];
  for (const w of graph.work || []) {
    if (!(w.pages || []).some((p) => pages.includes(p))) continue;
    for (const pid of [w.person, ...(w.assignees || [])]) if (pid && !out.includes(pid)) out.push(pid);
  }
  const kept = out.filter((p) => !exclude.has(p));
  if (kept.length) return kept;
  const nodes = new Map((graph.nodes || []).map((n) => [n.id, n]));
  for (const page of pages) {
    const pid = ((nodes.get(page) || {}).last_change || {}).person;
    if (pid && !kept.includes(pid) && !exclude.has(pid)) kept.push(pid);
  }
  return kept;
}

function pageLink(graph, slug, embed = false) {
  const node = (graph.nodes || []).find((n) => n.id === slug);
  if (!graph.repo) return node ? node.title : slug; // no GitHub repo to link to
  const url = `https://github.com/${graph.repo}/blob/${graph.branch || "main"}/${node ? node.path : `docs/wiki/${slug}.md`}`;
  // in plain messages <url> stops Discord adding a preview card; embeds don't need it
  return `[${node ? node.title : slug}](${embed ? url : `<${url}>`})`;
}

// ---------------------------------------------------------------- the description

const SECTION_NAMES = ["who", "what", "why", "before", "after", "how to test", "wiki"];
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const NAMES = SECTION_NAMES.join("|");
// A section starts at "## Why" (heading alone on its line), "**Why**" or
// "**Why:**" (bold label, text may follow) or "Why:" (label, text may follow).
const HEADING_RE = new RegExp(`^\\s*(?:#{1,6}\\s*(${NAMES})\\s*:?\\s*$|(?:\\*\\*|__)(${NAMES})\\s*:?\\s*(?:\\*\\*|__)\\s*:?\\s*(.*)$|(${NAMES})\\s*:\\s*(.*)$)`, "i");
const LABEL_ONLY_RE = /^\s*(?:#{1,6}\s*\S|<details|<\/details|<summary)/i;
// "- Before: <old>. After: <new>." (the labels need their colon)
const BEFORE_AFTER_RE = /^\s*[-*]\s*(?:\*\*)?Before(?::\*\*|\*\*:|:)\s*(.+?)\s+(?:\*\*)?After(?::\*\*|\*\*:|:)\s*(.+?)\s*$/i;

const clean = (text) => text.trim().split("\n").map((l) => l.trimEnd()).join("\n").trim();

// [section, text on the same line] when the line starts a section, else null.
function heading(line) {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  const name = m[1] || m[2] || m[4];
  const rest = m[2] ? m[3] : m[4] ? m[5] : "";
  return [name.toLowerCase(), (rest || "").trim()];
}

// The first plain paragraph: no heading, label, bullet or fold.
function firstParagraph(text) {
  for (let block of (text || "").replace(COMMENT_RE, "").split(/\n\s*\n/)) {
    block = block.trim();
    if (!block || LABEL_ONLY_RE.test(block) || heading(block.split("\n")[0])) continue;
    if (/^\s*([-*+]|\d+\.)\s/.test(block) || block.toLowerCase().startsWith("wiki:")) continue;
    return block.split("\n").map((l) => l.trim()).join(" ");
  }
  return "";
}

// The pull request description as { section: text }, plus _first (its first
// paragraph). Template prompts in HTML comments count as empty.
function parseDescription(body) {
  const text = (body || "").replace(COMMENT_RE, "").replace(/\r\n/g, "\n");
  const sections = {};
  let current = null;
  let buf = [];
  const flush = () => {
    if (current && !(current in sections)) {
      const value = clean(buf.join("\n"));
      if (value) sections[current] = value;
    }
  };
  for (const line of text.split("\n")) {
    const head = heading(line);
    if (head) {
      flush();
      current = head[0];
      buf = head[1] ? [head[1]] : [];
    } else if (LABEL_ONLY_RE.test(line)) {
      flush();
      current = null;
      buf = [];
    } else if (current) buf.push(line);
  }
  flush();
  const before = [];
  const after = [];
  for (const line of text.split("\n")) {
    const m = BEFORE_AFTER_RE.exec(line);
    if (m) {
      before.push(m[1].replace(/\.+$/, ""));
      after.push(m[2].replace(/\.+$/, ""));
    }
  }
  const join = (list) => list.map((x) => (list.length > 1 ? `- ${x}.` : `${x}.`)).join("\n");
  if (before.length) {
    if (!sections.before) sections.before = join(before);
    if (!sections.after) sections.after = join(after);
  }
  const first = firstParagraph(text);
  if (first) sections._first = first;
  return sections;
}

const short = (text, limit = 900) => {
  text = text.trim();
  return text.length <= limit ? text : text.slice(0, limit - 3).trimEnd() + "...";
};

function color(person) {
  const n = parseInt(((person || {}).color || "").replace(/^#/, ""), 16);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------- events

function question(event, graph) {
  const issue = event.issue || {};
  if (!labels(issue).includes("question")) return null;
  if (event.action === "labeled") {
    if ((event.label || {}).name !== "question" || isEcho(issue)) return null; // "opened" already pinged
  } else if (event.action !== "opened") return null;
  const asker = (issue.user || {}).login || "";
  const pages = pagesFromLabels(issue, graph);
  const who = owners(graph, pages, new Set([(personBy(graph, { login: asker }) || {}).id].filter(Boolean)));
  const lines = [
    `**Question** from ${mention(personBy(graph, { login: asker }), asker || "someone")}` +
      (pages.length ? ` on ${pages.map((p) => pageLink(graph, p)).join(", ")}` : "") +
      `: ${issue.title || ""}`,
    `<${issue.html_url || ""}>`,
  ];
  if (who.length) lines.push("Can you help? " + who.map((p) => mention(personBy(graph, { id: p }))).join(" "));
  return { content: lines.join("\n") };
}

// Reviewer logins, or null when this event should not post. One post per
// review request: "opened" unless a draft, "ready_for_review", and
// "review_requested" unless a draft or the echo of "opened". Asking for
// several reviewers at once fires one event each; only the last one posts.
function reviewTargets(event) {
  const pr = event.pull_request || {};
  const current = (pr.requested_reviewers || []).map((r) => r.login).filter(Boolean);
  if (event.action === "opened") return pr.draft ? null : current;
  if (event.action === "ready_for_review") return current;
  if (event.action !== "review_requested" || pr.draft || isEcho(pr)) return null;
  const login = (event.requested_reviewer || {}).login;
  if (login && current.length && current[current.length - 1] !== login && current.includes(login)) return null;
  return current.length ? current : login ? [login] : [];
}

function review(event, graph) {
  if (reviewTargets(event) === null) return null;
  const pr = event.pull_request || {};
  const url = pr.html_url || "";
  const author = (pr.user || {}).login || "";
  const person = personBy(graph, { login: author });
  const work = (graph.work || []).find((w) => w.kind === "pr" && w.number === pr.number);
  const pages = (work && work.pages && work.pages.length ? work.pages : null) || pagesFromLabels(pr, graph);
  const sec = parseDescription(pr.body);

  let who = person ? `${person.name} (@${author})` : author ? `@${author}` : "someone";
  if (sec.who) who += "\n" + sec.who;
  const what = `**${pr.title || ""}**` + (sec.what ? `\n${sec.what}` : "");
  const why = sec.why || sec._first || NOT_FILLED;
  const wiki = pages.length ? pages.slice(0, 8).map((p) => pageLink(graph, p, true)).join(", ") : sec.wiki || "none listed";
  const field = (name, value) => ({ name, value: short(value), inline: false });
  const embed = {
    title: short(`Review: ${pr.title || ""}`, 250),
    url,
    fields: [
      field("Who", who),
      field("What", what),
      field("Why", why),
      field("Before", sec.before || NOT_FILLED),
      field("After", sec.after || NOT_FILLED),
      field("Wiki pages", wiki),
      field("Review it", url || "no link"),
    ],
  };
  if (!sec.why) embed.footer = { text: sec._first ? "Why not filled in - showing the description's first paragraph." : "Description template not filled in." };
  const c = color(person);
  if (c !== null) embed.color = c;
  // reviews go to the whole team, never one person: anyone can pick it up
  const asker = (person || {}).name || (author ? `@${author}` : "someone");
  return { content: `**Review requested by ${asker}** - any teammate can review: <${url}>`, embeds: [embed] };
}

// [kind, Discord payload] or null when the event needs no post. kind
// ("question" or "review") picks the webhook.
function buildMessage(eventName, event, graph) {
  if (eventName === "issues") {
    const payload = question(event, graph);
    return payload ? ["question", payload] : null;
  }
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const payload = review(event, graph);
    return payload ? ["review", payload] : null;
  }
  return null;
}

// Plain text of a payload, for the workflow log.
function asText(payload) {
  const out = [payload.content || ""];
  for (const e of payload.embeds || []) {
    out.push(e.title || "");
    for (const f of e.fields || []) out.push(`${f.name}: ${f.value}`);
    if (e.footer) out.push(e.footer.text);
  }
  return out.join("\n");
}

function webhookFor(kind, env = process.env) {
  for (const name of WEBHOOKS[kind]) {
    const value = (env[name] || "").trim();
    if (value) return [name, value];
  }
  return [null, ""];
}

// "gh pr create --reviewer" adds reviewers a moment after "opened" fires, so
// the event can list none: re-read them (and the body) from GitHub. Keeps
// the event's copy on any failure.
async function freshReviewers(event, token) {
  const pr = event.pull_request || {};
  if (!token || !pr.url) return;
  try {
    const res = await fetch(pr.url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "hypatia-ping" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return;
    const live = await res.json();
    if (Array.isArray(live.requested_reviewers)) pr.requested_reviewers = live.requested_reviewers;
    if (live.body !== undefined && live.body !== null) pr.body = live.body;
  } catch {
    // keep what the event said
  }
}

async function post(webhook, payload) {
  const body = { ...payload, content: (payload.content || "").slice(0, 1990), allowed_mentions: { parse: ["users"] } };
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "hypatia-ping" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status}`);
}

// `hypatia ping [--dry-run] [--event <file>]`
async function pingCommand(root, argv, { env = process.env, log = console.log, error = console.error } = {}) {
  let dryRun = false;
  let eventPath = env.GITHUB_EVENT_PATH || "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") dryRun = true;
    else if (a === "--event" || a.startsWith("--event=")) eventPath = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i] || "";
    else if (a === "--help" || a === "-h") {
      log("hypatia ping [--dry-run] [--event <file>]");
      return 0;
    } else {
      error(`Unknown option "${a}". Try --dry-run or --event <file>.`);
      return 2;
    }
  }
  const eventName = env.GITHUB_EVENT_NAME || "";
  const event = eventPath && fs.existsSync(eventPath) ? JSON.parse(fs.readFileSync(eventPath, "utf8")) : {};
  const kind = eventName === "issues" ? "question" : "review";
  const [name, webhook] = webhookFor(kind, env);
  if (!webhook && !dryRun) {
    log(`Discord not set up yet (no ${WEBHOOKS[kind].join(" / ")} secret); skipping.`);
    return 0;
  }
  const token = (env.GITHUB_TOKEN || "").trim() || null;
  if (eventName.startsWith("pull_request") && event.action === "opened") await freshReviewers(event, token);
  let graph;
  try {
    graph = await buildGraph({ root, token, publish: true, env, warn: (m) => error(`hypatia: ${m}`) });
  } catch (err) {
    if (!(err instanceof WikiError)) throw err;
    error(`hypatia: ${err.message}`);
    return 1;
  }
  const message = buildMessage(eventName, event, graph);
  if (!message) {
    log(`No ping for ${eventName || "this event"}/${event.action || "-"}.`);
    return 0;
  }
  const payload = message[1];
  if (dryRun) {
    log(`Would post to Discord:\n${asText(payload)}`);
    return 0;
  }
  try {
    await post(webhook, payload);
  } catch (err) {
    error(`hypatia: could not post to Discord (${err.message}).`);
    return 1;
  }
  log(`Posted to Discord (${name}):\n${asText(payload)}`);
  return 0;
}

module.exports = { pingCommand, buildMessage, parseDescription, firstParagraph, reviewTargets, owners, mention, asText, webhookFor, WEBHOOKS };
