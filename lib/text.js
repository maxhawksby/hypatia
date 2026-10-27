// Small text helpers shared by the builder and the team reader.
"use strict";

const fs = require("fs");

// Lines of a text, with no empty last line after a final newline.
function splitlines(text) {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Strip any of these characters from both ends of s.
function stripChars(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

// Split s at sep at most max times: the last piece keeps the rest.
function splitMax(s, sep, max) {
  const out = [];
  let rest = s;
  while (out.length < max) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

// "key: value" or "key: [a, b]", with surrounding quotes stripped.
function parseValue(value) {
  value = value.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .filter((v) => v.trim())
      .map((v) => stripChars(v.trim(), "'\""));
  }
  return stripChars(value, "'\"");
}

// Text files with \r\n and \r turned into \n. A byte order mark (some
// Windows editors add one) is dropped, or a page's front matter would not be
// found and the page would silently disappear.
const readText = (file) => fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

// Lengths and cuts by character, not UTF-16 unit, so emoji count as one.
const chars = (s) => Array.from(s);

// "Ana López" -> "ana-lopez": lowercase words joined by '-'.
function slugify(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Plain code-point order for strings.
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = { splitlines, stripChars, splitMax, parseValue, readText, chars, slugify, cmp };
