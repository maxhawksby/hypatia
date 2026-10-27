// Path globs for a page's `code:` list.
"use strict";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// Translate a path glob: ** = any folders, * = anything but '/', ? = one char.
//
// A pattern with no wildcard also matches everything inside it when it is a
// folder, so `src/foo` and `src/foo/` behave like `src/foo/**`.
function globToRegex(pattern) {
  pattern = pattern.trim();
  if (pattern.startsWith("./")) pattern = pattern.slice(2);
  pattern = pattern.replace(/^\/+/, "");
  if (!/[*?[]/.test(pattern)) {
    return new RegExp("^" + escape(pattern.replace(/\/+$/, "")) + "(/.*)?$");
  }
  let i = 0;
  let out = "";
  while (i < pattern.length) {
    const c = pattern[i];
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += escape(c);
      i += 1;
    }
  }
  return new RegExp("^" + out + "$");
}

const cache = new Map();
function matches(file, patterns) {
  return patterns.some((p) => {
    if (!cache.has(p)) cache.set(p, globToRegex(p));
    return cache.get(p).test(file);
  });
}

module.exports = { globToRegex, matches };
