// Small GitHub REST helpers for the builder. Node built-ins only (fetch).
"use strict";

// An HTTP error from GitHub, with the status kept so callers can tell
// "not allowed" (403, 404) from "GitHub is down".
class GithubError extends Error {
  constructor(status, statusText) {
    super(`HTTP Error ${status}: ${statusText}`);
    this.status = status;
  }
}

const API = "https://api.github.com";

async function request(token, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "hypatia-build" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new GithubError(res.status, res.statusText);
  return res;
}

// One API object, e.g. getOne(token, "repos/a/b/commits/<sha>").
async function getOne(token, apiPath) {
  return (await request(token, `${API}/${apiPath}`)).json();
}

// Every page of a repo's API list, following the Link: rel="next" header.
async function getAll(token, repo, apiPath) {
  let url = `${API}/repos/${repo}/${apiPath}`;
  const out = [];
  while (url) {
    const res = await request(token, url);
    out.push(...(await res.json()));
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
    url = m ? m[1] : null;
  }
  return out;
}

// True when the token simply may not see this (no access, private data,
// endpoint needs push rights): the build carries on without it, quietly.
const notAllowed = (err) => err instanceof GithubError && [401, 403, 404, 422].includes(err.status);

module.exports = { GithubError, getOne, getAll, notAllowed };
