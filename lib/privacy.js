// The privacy guard: finds personal data and secrets in the wiki pages and in
// the site data before anything is published.
//
// It looks for:
// - email addresses and phone numbers,
// - student and other ID numbers (US social security numbers, and numbers
//   right after words like "student ID" or "NetID"),
// - API keys and secrets in common formats: AWS, GitHub, Stripe, Supabase,
//   JSON web tokens (Supabase service keys are these), OpenAI, Anthropic,
//   Slack, Google, private key blocks, and connection strings with a password.
//
// Allowed, never reported:
// - the GitHub "noreply" addresses of people on the team,
// - addresses at example.com, example.org, example.net, example.edu and the
//   reserved test domains (.example, .test, .invalid, .localhost, .local),
//   "git@github.com"-style addresses, no-reply senders and stand-ins such as
//   firstname.lastname@ or you@,
// - anything listed under `allow:` in docs/hypatia.yml: an exact value, a
//   domain ("@acme.dev" or "acme.dev" for every address there), or a pattern
//   with * (e.g. "sk_test_*").
//
// Every value it reports is masked, so the warning never repeats the secret.
//
// Node built-ins only.
"use strict";

const fs = require("fs");
const path = require("path");
const { readText, splitlines } = require("./text");

// File types that look like a domain's last part in "logo@2x.png".
const FILE_TLDS = new Set(
  "png jpg jpeg gif svg webp ico avif bmp js mjs cjs ts tsx jsx css scss sass less json md mdx html htm yml yaml toml txt csv py rb go rs java kt swift c h cpp hpp cs php map lock xml pdf mp4 mov webm mp3 wav ogg zip gz tgz tar wasm sh ps1 bat".split(" ")
);
const RESERVED_DOMAIN = /(^|\.)(example\.(com|org|net|edu)|example|test|invalid|localhost|local)$/i;
// Not a person: git hosts' ssh user, no-reply senders, and stand-ins such as
// firstname.lastname@school.edu.
const SERVICE_LOCAL_PART =
  /^(git|no-?reply|do-?not-?reply|donotreply|first[._-]?(name)?[._-]?last(name)?|first|firstname|lastname|name|your?[._-]?(name|email)?|user(name)?|someone|somebody|email|me|x+|abc|test(user)?)$/i;

// Values that stand in for a password in docs ("postgres://user:<password>@...").
const PLACEHOLDER_PASSWORD =
  /^(\*+|x+|\.+|password|passwd|pass|pwd|secret|changeme|example|test|user|root|admin|postgres|<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[^%]+%|your[-_]?password[-_a-z]*)$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?$/i;

// Each rule: kind (what to call it), re (global; group 1, when present, is
// the part to report), and an optional ok(value, match) that clears a hit.
const RULES = [
  { kind: "private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "AWS access key", re: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g },
  { kind: "AWS secret key", re: /aws_?secret_?access_?key\W{1,4}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi },
  { kind: "GitHub token", re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { kind: "Stripe secret key", re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{24,})\b/g },
  { kind: "Supabase secret key", re: /\b(sb_secret_[A-Za-z0-9_-]{20,})/g },
  { kind: "JSON web token", re: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g },
  { kind: "Anthropic API key", re: /\b(sk-ant-[A-Za-z0-9_-]{20,})/g },
  {
    kind: "OpenAI API key",
    re: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,})/g,
    ok: (v) => v.startsWith("sk-ant-") || !/\d/.test(v) || !/[A-Za-z]/.test(v.slice(3)),
  },
  { kind: "Slack token", re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g },
  { kind: "Google API key", re: /\b(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/g },
  {
    kind: "connection string with a password",
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`<>]+:([^\s@/'"`]+)@([^\s/'"`?#)]+)/gi,
    ok: (password, m) => PLACEHOLDER_PASSWORD.test(password) || LOCAL_HOST.test(m[2]),
  },
  {
    kind: "email address",
    re: /(?<![\w.%+-])([A-Za-z0-9][A-Za-z0-9._%+-]*@(?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,24}))(?![\w-]|\.[A-Za-z0-9])/g,
    ok: (v, m) => FILE_TLDS.has(m[2].toLowerCase()),
  },
  { kind: "social security number", re: /(?<![\w-])((?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4})(?![\w-])/g },
  {
    kind: "ID number",
    re: /\b(?:student|employee|staff|patient|customer|member|peoplesoft|banner|husky|campus)[ _-]?(?:id|number|no|num|#)\b[^\n\d]{0,20}?(?<![\w.-])(\d{5,10})(?![\w.-])/gi,
  },
  { kind: "ID number", re: /\bID\s?[:#=]\s?(\d{7,10})\b/g },
  { kind: "NetID", re: /\bnet[ _-]?id\b[^\n]{0,20}?\b([a-z]{3}\d{5})\b/gi },
  {
    kind: "phone number",
    re: /(?<![\w.+/-])((?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4})(?![\w-]|\.\d)/g,
  },
  {
    kind: "phone number",
    re: /(?<![\w.+/-])(\+\d{1,3}(?:[ .-]\(?\d{1,4}\)?){2,5})(?![\w-]|\.\d)/g,
    ok: (v) => v.replace(/\D/g, "").length < 9,
  },
];

// A value with only its first few characters showing.
function mask(value) {
  const at = value.indexOf("@");
  if (/^[^@\s]+@[^@\s]+$/.test(value)) {
    const domain = value.slice(at + 1);
    const tld = domain.slice(domain.lastIndexOf("."));
    return `${value[0]}***@${domain[0]}***${tld}`;
  }
  const show = value.length >= 16 ? 4 : value.length >= 8 ? 2 : 0;
  return value.slice(0, show) + "****";
}

// allowed(hit) for a repo: team noreply addresses, reserved domains and the
// config's allow: list.
function allowList({ allow = [], logins = [] } = {}) {
  const team = new Set(logins.filter(Boolean).map((l) => l.toLowerCase()));
  const rules = allow.map((entry) => {
    const e = String(entry).trim().toLowerCase();
    if (e.includes("*")) {
      const re = new RegExp("^" + e.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
      return (v) => re.test(v);
    }
    if (/^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e) && !e.includes("@", 1)) {
      const domain = e.replace(/^@/, "");
      return (v) => v.toLowerCase().endsWith("@" + domain) || v.toLowerCase().endsWith("." + domain) || v.toLowerCase() === e;
    }
    return (v) => v.toLowerCase() === e;
  });
  return (hit) => {
    if (hit.kind === "email address") {
      const [local, domain] = [hit.value.slice(0, hit.value.lastIndexOf("@")), hit.value.slice(hit.value.lastIndexOf("@") + 1)];
      if (RESERVED_DOMAIN.test(domain) || SERVICE_LOCAL_PART.test(local)) return true;
      const m = /^(?:\d+\+)?([^@]+)$/.exec(local);
      if (/^users\.noreply\.github\.com$/i.test(domain) && m && team.has(m[1].toLowerCase())) return true;
    }
    return rules.some((ok) => ok(hit.value));
  };
}

// Every hit in a text: [{kind, value, masked, line, column}], allowed ones
// left out, at most one hit per value and line.
function scanText(text, allowed = () => false) {
  const hits = [];
  const lines = splitlines(text);
  lines.forEach((line, i) => {
    const taken = []; // [start, end) already reported on this line
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const value = m[1] !== undefined ? m[1] : m[0];
        const start = m.index + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
        if (taken.some(([a, b]) => start < b && start + value.length > a)) continue;
        if (rule.ok && rule.ok(value, m)) continue;
        const hit = { kind: rule.kind, value, masked: mask(value), line: i + 1, column: start + 1 };
        if (allowed(hit)) continue;
        taken.push([start, start + value.length]);
        hits.push(hit);
      }
    }
  });
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

// The parts of the site data not already covered by scanning the page files:
// [where, text] for every string, e.g. ["recent[2].message", "..."].
function dataStrings(graph) {
  const out = [];
  (function walk(value, where) {
    if (typeof value === "string") out.push([where, value]);
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${where}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        // a page's text is scanned from its file, with real line numbers
        if (where.startsWith("nodes[") && (k === "markdown" || k === "summary")) continue;
        walk(v, where ? `${where}.${k}` : k);
      }
    }
  })(graph, "");
  return out;
}

// Scans what a site built from graph would show: each page's file (front
// matter and text, with line numbers) and the rest of the site data.
// Returns [{file, line, kind, masked, page, private}], file being a repo path
// or "site data (<where>)"; private is set for a page only the local site
// shows (a published build has none).
function scanSite(root, graph, { allow = [] } = {}) {
  const allowed = allowList({ allow, logins: (graph.people || []).map((p) => p.github) });
  const found = [];
  for (const node of graph.nodes || []) {
    const rel = node.path || "README.md";
    const file = path.join(root, rel);
    const text = fs.existsSync(file) ? readText(file) : node.markdown || "";
    for (const hit of scanText(text, allowed)) found.push({ file: rel, page: node.id, ...(node.private ? { private: true } : {}), ...hit });
  }
  for (const [where, text] of dataStrings(graph)) {
    for (const hit of scanText(text, allowed)) found.push({ file: `site data (${where})`, page: null, ...hit, line: null });
  }
  return found.map(({ value, ...rest }) => rest); // never carry the raw value further
}

// Scans page files directly (used for private pages, which are not in the
// published data). files: repo paths.
function scanFiles(root, files, { allow = [], logins = [] } = {}) {
  const allowed = allowList({ allow, logins });
  const found = [];
  for (const rel of files) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    for (const hit of scanText(readText(file), allowed)) found.push({ file: rel, ...hit });
  }
  return found.map(({ value, ...rest }) => rest);
}

// One line per hit: "docs/wiki/a.md:12: email address j***@g***.com".
function describeHits(hits) {
  return hits.map((h) => `${h.file}${h.line ? `:${h.line}` : ""}: ${h.kind} ${h.masked}${h.private ? " (private page, never published)" : ""}`);
}

module.exports = { RULES, mask, allowList, scanText, scanSite, scanFiles, describeHits, dataStrings };
