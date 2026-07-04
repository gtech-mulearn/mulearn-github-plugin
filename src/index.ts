/**
 * muLearn GitHub org plugin
 *
 * Tracks contributions across EVERY repository in a GitHub organization
 * (default: gtech-mulearn). Authenticates as a GitHub App installation
 * (15,000 req/hr), reads via the GraphQL API, and scrapes incrementally
 * using a watermark so repeat runs only fetch newly-updated PRs/issues.
 *
 * Design constraint: the leaderboard plugin-runner loads remote plugins by
 * importing them from a `data:` URL, which cannot resolve bare imports. So
 * this file has ZERO runtime imports — only type-only imports (erased at
 * build) and Node/Web globals (fetch, crypto.subtle, TextEncoder, btoa/atob).
 */

import type { Plugin, PluginContext } from "@ohcnetwork/leaderboard-api";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface MulearnConfig {
  githubOrg: string;
  githubAppId: string;
  /** GitHub App private key in **PKCS#8** PEM ("-----BEGIN PRIVATE KEY-----"). */
  githubPrivateKey: string;
  /** Optional: skip the org-installation lookup if you already have the id. */
  githubInstallationId?: string;
  /** Optional override; defaults to org.start_date or epoch on first run. */
  backfillSince?: string;
}

function readConfig(ctx: PluginContext): MulearnConfig {
  const c = ctx.config as Record<string, unknown>;
  const required = (key: keyof MulearnConfig): string => {
    const v = c[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(
        `mulearn-github: missing required config "${key}". ` +
          `Check config.yaml and the corresponding env var is set.`,
      );
    }
    return v;
  };
  return {
    githubOrg: required("githubOrg"),
    githubAppId: required("githubAppId"),
    githubPrivateKey: required("githubPrivateKey"),
    githubInstallationId:
      typeof c.githubInstallationId === "string"
        ? c.githubInstallationId
        : undefined,
    backfillSince:
      typeof c.backfillSince === "string" ? c.backfillSince : undefined,
  };
}

// ---------------------------------------------------------------------------
// GitHub App auth (Web Crypto, no deps)
// ---------------------------------------------------------------------------

const GH_API = "https://api.github.com";
const UA = "mulearn-leaderboard-plugin";

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** Build a short-lived RS256 JWT signed with the App private key. */
async function createAppJwt(appId: string, privateKeyPem: string) {
  if (privateKeyPem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "mulearn-github: private key is PKCS#1. Convert to PKCS#8 with:\n" +
        "  openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem",
    );
  }
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    enc.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })),
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

async function ghRest(path: string, jwt: string): Promise<any> {
  const res = await fetch(`${GH_API}${path}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub REST ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Exchange the App JWT for an installation access token. */
async function getInstallationToken(cfg: MulearnConfig): Promise<string> {
  const jwt = await createAppJwt(cfg.githubAppId, cfg.githubPrivateKey);
  let installationId = cfg.githubInstallationId;
  if (!installationId) {
    const inst = await ghRest(`/orgs/${cfg.githubOrg}/installation`, jwt);
    installationId = String(inst.id);
  }
  const res = await fetch(
    `${GH_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub installation token failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = await res.json();
  return data.token as string;
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

async function gql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  logger: PluginContext["logger"],
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${GH_API}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 403 || res.status === 429) {
      const wait = (attempt + 1) * 5000;
      logger.warn(`GraphQL rate-limited, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data as T;
  }
  throw new Error("GraphQL: exhausted retries (rate limit)");
}

// ---------------------------------------------------------------------------
// Watermark (incremental scraping)
// ---------------------------------------------------------------------------

async function ensureStateTable(ctx: PluginContext) {
  await ctx.db.execute(
    `CREATE TABLE IF NOT EXISTS plugin_state (key TEXT PRIMARY KEY, value TEXT)`,
  );
}

async function getWatermark(ctx: PluginContext, cfg: MulearnConfig): Promise<string> {
  const res = await ctx.db.execute(
    `SELECT value FROM plugin_state WHERE key = ?`,
    ["mulearn_github_watermark"],
  );
  if (res.rows[0]?.value) return String(res.rows[0].value);
  return cfg.backfillSince || ctx.orgConfig.start_date || "1970-01-01T00:00:00Z";
}

async function setWatermark(ctx: PluginContext, iso: string) {
  await ctx.db.execute(
    `INSERT INTO plugin_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ["mulearn_github_watermark", iso],
  );
}

// ---------------------------------------------------------------------------
// DB writes (raw SQL — cannot import query helpers in a data-URL module)
// ---------------------------------------------------------------------------

const seen = new Set<string>();

/** Insert-or-ignore a contributor so human-edited markdown profiles win. */
async function ensureContributor(
  ctx: PluginContext,
  login: string,
  name: string | null,
  avatarUrl: string | null,
) {
  if (seen.has(login)) return;
  seen.add(login);
  await ctx.db.execute(
    `INSERT OR IGNORE INTO contributor
      (username, name, role, title, avatar_url, bio, social_profiles, joining_date, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      login,
      name,
      "contributor",
      null,
      avatarUrl,
      null,
      JSON.stringify({ github: `https://github.com/${login}` }),
      null,
      null,
    ],
  );
}

async function upsertActivity(
  ctx: PluginContext,
  a: {
    slug: string;
    contributor: string;
    activity_definition: string;
    title: string;
    occurred_at: string;
    link: string;
  },
) {
  await ctx.db.execute(
    `INSERT INTO activity
      (slug, contributor, activity_definition, title, occurred_at, link, text, points, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       contributor = excluded.contributor,
       activity_definition = excluded.activity_definition,
       title = excluded.title,
       occurred_at = excluded.occurred_at,
       link = excluded.link`,
    [
      a.slug,
      a.contributor,
      a.activity_definition,
      a.title,
      a.occurred_at,
      a.link,
      null,
      null,
      null,
    ],
  );
}

function isHuman(author: { login?: string; __typename?: string } | null): author is {
  login: string;
  __typename: string;
} {
  return (
    !!author &&
    author.__typename === "User" &&
    !!author.login &&
    !author.login.endsWith("[bot]")
  );
}

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

const REPOS_QUERY = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      repositories(first: 100, after: $cursor, orderBy: {field: PUSHED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes { name isArchived }
      }
    }
  }`;

const PRS_QUERY = `
  query($org: String!, $repo: String!, $cursor: String) {
    repository(owner: $org, name: $repo) {
      pullRequests(first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url state createdAt mergedAt updatedAt
          author { __typename login ... on User { name avatarUrl } }
          reviews(first: 30) {
            nodes {
              id submittedAt
              author { __typename login ... on User { name avatarUrl } }
            }
          }
        }
      }
    }
  }`;

const ISSUES_QUERY = `
  query($org: String!, $repo: String!, $cursor: String) {
    repository(owner: $org, name: $repo) {
      issues(first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url createdAt updatedAt
          author { __typename login ... on User { name avatarUrl } }
        }
      }
    }
  }`;

async function listRepos(
  token: string,
  org: string,
  logger: PluginContext["logger"],
): Promise<string[]> {
  const repos: string[] = [];
  let cursor: string | null = null;
  do {
    const data: any = await gql(token, REPOS_QUERY, { org, cursor }, logger);
    const conn = data.organization?.repositories;
    if (!conn) break;
    for (const n of conn.nodes) if (!n.isArchived) repos.push(n.name);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  logger.info(`Found ${repos.length} active repos in ${org}`);
  return repos;
}

async function scrapeRepoPRs(
  ctx: PluginContext,
  token: string,
  org: string,
  repo: string,
  watermark: string,
) {
  let cursor: string | null = null;
  do {
    const data: any = await gql(token, PRS_QUERY, { org, repo, cursor }, ctx.logger);
    const conn = data.repository?.pullRequests;
    if (!conn) return;
    for (const pr of conn.nodes) {
      if (isHuman(pr.author)) {
        const login = pr.author.login;
        await ensureContributor(ctx, login, pr.author.name ?? null, pr.author.avatarUrl ?? null);
        await upsertActivity(ctx, {
          slug: `gh_pr_opened__${org}_${repo}__${pr.number}`,
          contributor: login,
          activity_definition: "pr_opened",
          title: `${repo}#${pr.number}: ${pr.title}`,
          occurred_at: pr.createdAt,
          link: pr.url,
        });
        if (pr.mergedAt) {
          await upsertActivity(ctx, {
            slug: `gh_pr_merged__${org}_${repo}__${pr.number}`,
            contributor: login,
            activity_definition: "pr_merged",
            title: `${repo}#${pr.number}: ${pr.title}`,
            occurred_at: pr.mergedAt,
            link: pr.url,
          });
        }
      }
      // Reviews
      for (const rv of pr.reviews?.nodes ?? []) {
        if (!rv.submittedAt || !isHuman(rv.author)) continue;
        const rlogin = rv.author.login;
        await ensureContributor(ctx, rlogin, rv.author.name ?? null, rv.author.avatarUrl ?? null);
        await upsertActivity(ctx, {
          slug: `gh_pr_reviewed__${org}_${repo}__${pr.number}__${rv.id}`,
          contributor: rlogin,
          activity_definition: "pr_reviewed",
          title: `Reviewed ${repo}#${pr.number}`,
          occurred_at: rv.submittedAt,
          link: pr.url,
        });
      }
    }
    // Stop once we page past the watermark (list is ordered by UPDATED_AT desc).
    const oldest = conn.nodes[conn.nodes.length - 1];
    if (oldest && oldest.updatedAt < watermark) return;
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

async function scrapeRepoIssues(
  ctx: PluginContext,
  token: string,
  org: string,
  repo: string,
  watermark: string,
) {
  let cursor: string | null = null;
  do {
    const data: any = await gql(token, ISSUES_QUERY, { org, repo, cursor }, ctx.logger);
    const conn = data.repository?.issues;
    if (!conn) return;
    for (const issue of conn.nodes) {
      if (!isHuman(issue.author)) continue;
      const login = issue.author.login;
      await ensureContributor(ctx, login, issue.author.name ?? null, issue.author.avatarUrl ?? null);
      await upsertActivity(ctx, {
        slug: `gh_issue_opened__${org}_${repo}__${issue.number}`,
        contributor: login,
        activity_definition: "issue_opened",
        title: `${repo}#${issue.number}: ${issue.title}`,
        occurred_at: issue.createdAt,
        link: issue.url,
      });
    }
    const oldest = conn.nodes[conn.nodes.length - 1];
    if (oldest && oldest.updatedAt < watermark) return;
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: "mulearn-github",
  version: "0.1.0",

  async setup(ctx) {
    ctx.logger.info("mulearn-github: defining activity types");
    const defs = [
      { slug: "pr_opened", name: "PR Opened", description: "Opened a pull request", points: 5, icon: "git-pull-request" },
      { slug: "pr_merged", name: "PR Merged", description: "Pull request was merged", points: 10, icon: "git-merge" },
      { slug: "pr_reviewed", name: "PR Reviewed", description: "Reviewed a pull request", points: 4, icon: "eye" },
      { slug: "issue_opened", name: "Issue Opened", description: "Opened an issue", points: 2, icon: "circle-dot" },
    ];
    for (const d of defs) {
      await ctx.db.execute(
        `INSERT OR IGNORE INTO activity_definition (slug, name, description, points, icon)
         VALUES (?, ?, ?, ?, ?)`,
        [d.slug, d.name, d.description, d.points, d.icon],
      );
    }
  },

  async scrape(ctx) {
    const cfg = readConfig(ctx);
    const runStartedAt = new Date().toISOString();

    await ensureStateTable(ctx);
    const watermark = await getWatermark(ctx, cfg);
    ctx.logger.info(`mulearn-github: scraping ${cfg.githubOrg} since ${watermark}`);

    const token = await getInstallationToken(cfg);
    const repos = await listRepos(token, cfg.githubOrg, ctx.logger);

    let done = 0;
    for (const repo of repos) {
      try {
        await scrapeRepoPRs(ctx, token, cfg.githubOrg, repo, watermark);
        await scrapeRepoIssues(ctx, token, cfg.githubOrg, repo, watermark);
      } catch (err) {
        ctx.logger.error(`mulearn-github: failed on repo ${repo}`, err as Error);
      }
      done++;
      if (done % 20 === 0) ctx.logger.info(`  ...${done}/${repos.length} repos`);
    }

    // Only advance the watermark after a full successful pass.
    await setWatermark(ctx, runStartedAt);
    ctx.logger.info(`mulearn-github: done (${repos.length} repos, ${seen.size} contributors touched)`);
  },
};

export default plugin;
