# mulearn-github-plugin

Leaderboard plugin that tracks contributions across **every repository** in the
`gtech-mulearn` GitHub organization. Authenticates as a **GitHub App**
installation, reads via the **GraphQL API**, and scrapes **incrementally** using
a stored watermark so repeat runs only fetch newly-updated PRs/issues.

Tracked activities: `pr_opened` (5pts), `pr_merged` (10), `pr_reviewed` (4),
`issue_opened` (2). Bots and archived repos are skipped. Contributors are
inserted with `INSERT OR IGNORE`, so human-edited markdown profiles always win.

## Why zero dependencies?

The leaderboard `plugin-runner` loads a remote plugin by fetching the JS and
importing it from a `data:` URL — which **cannot resolve bare imports**. So this
bundle must be a single self-contained ESM file with no runtime `import`s. It
uses only Web/Node globals (`fetch`, `crypto.subtle`, `TextEncoder`,
`btoa`/`atob`) and raw SQL via `ctx.db.execute`. `npm run build` (tsup) produces
`dist/index.js`.

## 1. Create the GitHub App

1. Org → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Permissions (read-only): **Repository → Contents, Issues, Pull requests,
   Metadata**; **Organization → Members**.
3. No webhook needed. Set "Where can this be installed" → **Only this account**.
4. Create, then **Generate a private key** (downloads a `.pem`).
5. **Install** the App on the `gtech-mulearn` org → **All repositories**.
6. Note the **App ID** (App settings page) and, optionally, the
   **Installation ID** (URL of the installation settings page).

### Convert the private key to PKCS#8

GitHub issues a PKCS#1 key (`BEGIN RSA PRIVATE KEY`). Web Crypto needs PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
```

Use the contents of `app.pkcs8.pem` (starts with `-----BEGIN PRIVATE KEY-----`)
as the `GH_APP_PRIVATE_KEY` env var.

## 2. Build & host

```bash
npm install
npm run build      # -> dist/index.js
```

Publish so `config.yaml` can reference it by URL. Push this repo to
`gtech-mulearn/mulearn-github-plugin`, commit `dist/index.js` (or attach it to a
Release), and reference via jsDelivr:

```
https://cdn.jsdelivr.net/gh/gtech-mulearn/mulearn-github-plugin@main/dist/index.js
```

> jsDelivr caches aggressively. Pin a tag (`@v0.1.0`) or purge the cache when you
> ship a new build.

## 3. Reference it in the data repo `config.yaml`

```yaml
leaderboard:
  plugins:
    github:
      name: muLearn GitHub
      source: https://cdn.jsdelivr.net/gh/gtech-mulearn/mulearn-github-plugin@main/dist/index.js
      config:
        githubOrg: gtech-mulearn
        githubAppId: ${{ env.GH_APP_ID }}
        githubPrivateKey: ${{ env.GH_APP_PRIVATE_KEY }}
        # githubInstallationId: ${{ env.GH_APP_INSTALLATION_ID }}  # optional
        # backfillSince: "2020-01-01T00:00:00Z"                    # optional
```

## Required environment variables (at scrape time)

| Var                       | Required | Notes                                        |
| ------------------------- | -------- | -------------------------------------------- |
| `GH_APP_ID`               | yes      | Numeric App ID                               |
| `GH_APP_PRIVATE_KEY`      | yes      | **PKCS#8** PEM contents                      |
| `GH_APP_INSTALLATION_ID`  | no       | Skips the org-installation lookup if present |

## Incremental behavior

The watermark is stored in a `plugin_state` row in the leaderboard DB and only
advances after a full successful pass. First run = full backfill (from
`backfillSince`, else `org.start_date`, else epoch). Activity slugs are stable
and writes use `ON CONFLICT … DO UPDATE`, so re-runs never duplicate.
