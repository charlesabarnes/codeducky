# Code Ducky

A self-review app for your own branches and the pull requests you are asked to review. It diffs a local
checkout (read through the browser's File System Access API) or a GitHub pull request, and keeps review
sessions, line notes, checklists and viewed files. It is an installable PWA backed by a small Bun server
that syncs each user's data, signs users in with GitHub, and serves an MCP endpoint, a pre-push gate and a
channel for Claude Code.

Each GitHub account sees only its own data. Admins manage accounts but never see their contents.

## Local development

Needs Node 24 and Bun 1.4, and a Chromium-based desktop browser for folder access.

```sh
npm install
npm run dev:server   # API on :8787, fake GitHub sign-in, admin passphrase "codeducky"
npm run dev          # Vite on :5173, proxying the server paths to :8787
```

Without `CODEDUCKY_GITHUB_CLIENT_ID`, development uses a fake GitHub: its "Sign in as" page lets you
sign in as any login.

| Command | What it runs |
|---|---|
| `npm run typecheck` / `npm run lint` | `tsc -b` / ESLint |
| `npm test` | Vitest unit tests (`test/`), then `bun test` for `server/` and `plugin/` |
| `npm run test:integration` | `test/**/*.integration.test.ts` against a real server it starts |
| `npm run test:e2e` | Playwright, below |
| `npm run build` | Type-checks and builds the PWA into `dist/` |
| `npm start` | The production server, serving `dist/` |
| `npm run vapid` | Prints a new VAPID key pair for Web Push |

### End-to-end tests

```sh
npx playwright install chromium   # once
npm run test:e2e
```

Playwright builds the app and starts `bun server/index.ts` on `127.0.0.1:4319` (`E2E_PORT` to change it)
with the fake GitHub, an admin passphrase and a temporary `DATA_DIR`, then drives Chromium. Nothing
reaches the network: sign-in goes through the server's fake GitHub, and test repos are written into the
browser's private file system. The run is not part of `npm test`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port. |
| `DATA_DIR` | `./data` | Where the SQLite database lives. |
| `CODEDUCKY_DB` | `$DATA_DIR/codeducky.db` | Database file. |
| `WEB_DIST` | `./dist` | Built PWA to serve; without it only the API runs. |
| `NODE_ENV` | | `production` makes the GitHub app and the public URL required and turns off the dev admin passphrase. |
| `CODEDUCKY_PUBLIC_URL` | request origin | Public origin for GitHub callbacks, OAuth metadata and links. **Required in production.** |
| `CODEDUCKY_GITHUB_CLIENT_ID` | | GitHub OAuth App client id. Required in production unless fake. |
| `CODEDUCKY_GITHUB_CLIENT_SECRET` | | GitHub OAuth App client secret. |
| `CODEDUCKY_GITHUB_FAKE` | `1` in dev without a client id | Use the fake GitHub ("sign in as anyone"). |
| `CODEDUCKY_INSECURE_FAKE_GITHUB` | | Also `1` to allow the fake GitHub in production, for throwaway previews only. |
| `CODEDUCKY_ADMIN_PASSPHRASE` | `codeducky` in dev, unset in production | Admin sign-in; unset turns it off. |
| `CODEDUCKY_SIGNUPS` | `open` | `closed` refuses new accounts; existing users still sign in. |
| `CODEDUCKY_MAX_USERS` | no cap | Cap on GitHub accounts. |
| `CODEDUCKY_QUOTA_RECORDS` | `20000` | Default rows per user, deletions included. |
| `CODEDUCKY_QUOTA_BYTES` | `52428800` (50 MB) | Default live data per user. |
| `CODEDUCKY_RATE_SYNC` | `120` per minute | `/api/sync` requests per user. |
| `CODEDUCKY_RATE_MCP` | `300` per minute | `/mcp` requests per user. |
| `CODEDUCKY_RATE_GATE` | `120` per minute | `/api/gate` requests per user. |
| `CODEDUCKY_RATE_CHANNEL_TASKS` | `30` per minute | Tasks sent to Claude Code per user. |
| `CODEDUCKY_RATE_GITHUB_START` | `20` per 10 minutes | GitHub sign-in starts per client address. |
| `CODEDUCKY_RATE_NEW_ACCOUNTS` | `30` per hour | New accounts, across everyone. |
| `CODEDUCKY_RATE_PUSH` | `60` per hour | Web Push messages per user; one message to all of a user's devices counts once. |
| `CODEDUCKY_VAPID_PUBLIC_KEY` | | Web Push public key (`npm run vapid`). Unset turns push off. |
| `CODEDUCKY_VAPID_PRIVATE_KEY` | | Web Push private key; must belong to the public key. |
| `CODEDUCKY_VAPID_SUBJECT` | | Contact for the push services: `mailto:you@example.com` or an `https:` URL. |
| `CODEDUCKY_SERVER_PORT` | `8787` | Dev only: where Vite proxies the server paths. |

`CODEDUCKY_PASSPHRASE` was renamed to `CODEDUCKY_ADMIN_PASSPHRASE`; the server refuses to start while
it is set. Rate variables set the limit per window; bursts scale with them.

## Deploying

`compose.yaml` builds the `Dockerfile` and keeps the database in the `data` volume. Set these secrets:

- `CODEDUCKY_PUBLIC_URL`, the https origin, e.g. `https://codeducky.example.com`
- `CODEDUCKY_GITHUB_CLIENT_ID` and `CODEDUCKY_GITHUB_CLIENT_SECRET`
- `CODEDUCKY_ADMIN_PASSPHRASE`, long and random, to use the admin panel

Optional: `CODEDUCKY_SIGNUPS`, `CODEDUCKY_MAX_USERS`, the quota and rate variables, and the three
`CODEDUCKY_VAPID_*` secrets for Web Push (below). The health check is `GET /api/health`.

### GitHub OAuth App

GitHub, Settings, Developer settings, OAuth Apps, New OAuth App:

- Homepage URL: your `CODEDUCKY_PUBLIC_URL`
- Authorization callback URL: `<CODEDUCKY_PUBLIC_URL>/api/auth/github/callback`
- Leave Device Flow off, then generate a client secret.

An OAuth App has one callback host, so use a second app for real GitHub sign-in locally
(`http://localhost:5173/api/auth/github/callback`), or the fake GitHub. Code Ducky asks for no scopes,
reads only the GitHub id and login, and revokes the GitHub token straight away.

## Web Push

Notifications reach a device even when Code Ducky is closed there once the server has a VAPID key pair.
Without one, push is off and the PWA hides the option; notifications still work while the app is open.

1. Run `npm run vapid` once. It prints `CODEDUCKY_VAPID_PUBLIC_KEY` and `CODEDUCKY_VAPID_PRIVATE_KEY`.
2. Set both as secrets, plus `CODEDUCKY_VAPID_SUBJECT`: a `mailto:` address or `https:` URL the browsers'
   push services can contact about your traffic. The server refuses to start with only some of the three,
   or with a private key that does not belong to the public key.
3. Keep the pair. A new pair ends every subscription; each device subscribes again the next time Code Ducky
   opens there.

In the PWA, Settings, notifications, tick "even when Code Ducky is closed" on each device that should get
pushes. The per-type choices ("send to Claude" tasks, review requests) are stored with that device's
subscription on the server. Signing the device out, or turning notifications off, unsubscribes it.

- **Tasks.** A "send to Claude" task that reaches done or failed is pushed to every device that wants tasks.
- **Review requests.** The server never calls GitHub; it sees requests when a device syncs the inbox it
  fetched. When a sync adds requested pull requests that were not in the stored inbox, they are pushed to
  the user's other devices, not to the device that synced, whose open app shows its own notification. The
  first inbox an account syncs only sets the baseline. So a request arrives once any device with Code Ducky
  open (it refreshes the inbox every few minutes) picks it up.
- **No double notifications.** A push carries the same tag as the in-app notification for the event, so the
  two replace each other, and the service worker shows nothing while a window of the app has focus. Safari
  may end a subscription after several pushes shown no notification; the server then drops it on the next
  410, and the PWA subscribes again the next time it opens.

A push holds only a title, a short body (repo, branch or pull request) and the link to open: never note
contents or Claude's messages. Messages are encrypted for the device (RFC 8291) and signed with the VAPID
key (RFC 8292). An account keeps up to 10 subscriptions; registering another drops the least recently used.
The server only sends to the browsers' push services (Google, Mozilla, Apple, Microsoft), drops a
subscription the service reports gone (404 or 410) or after 5 failures in a row, and logs failures with
the push service's host only.

## Admin

Sign in under Settings, "admin sign-in", with `CODEDUCKY_ADMIN_PASSPHRASE`. The admin session lasts 12
hours and cannot mint API tokens or approve MCP clients. The admin panel in Settings lists accounts with
their usage, tokens, approved apps and live channel sessions, and can disable, enable or delete an account
or set its quota. Disabling signs the user out everywhere, revokes their tokens and apps, and removes their
push subscriptions. Users can
delete their own account under Settings.

## Quotas

Each user has a row quota and a byte quota (defaults above). A write that would grow past either is
refused with `quota_exceeded` and stays on the device under "changes the server refused"; shrinking or
deleting always works. The admin can override a user's quota. Settings shows each user their usage.

## Releasing an API change

The PWA sends its build id (UTC `YYYYMMDDHHMMSS`) in `X-CodeDucky-Client`. The server refuses builds older
than `MIN_CLIENT_BUILD` in `server/clientVersion.ts` with 426, and the PWA asks to reload. When the API
changes in a way older clients cannot handle, set `MIN_CLIENT_BUILD` to the UTC time of the commit making
the change and deploy. Requests without the header (MCP, the plugin, the gate) are never refused.

## Connecting Claude Code

Settings has copyable versions of each of these.

- **MCP server.** `claude mcp add --transport http codeducky <CODEDUCKY_PUBLIC_URL>/mcp`, then approve in
  the browser by signing in with GitHub. Or create an API token under Settings and add
  `--header "Authorization: Bearer <token>"`. Claude Code then has tools for notes, sessions and
  checklists, and the `/mcp__codeducky__review` and `/mcp__codeducky__fix` prompts. claude.ai custom
  connectors use the same URL with OAuth.
- **Channel plugin** (research preview), to send review and fix tasks from the PWA into a running session:
  `claude plugin marketplace add charlesabarnes/codeducky`, `claude plugin install codeducky@codeducky`,
  then give it `CODEDUCKY_URL` (or `git config --global codeducky.url <url>`) and `CODEDUCKY_TOKEN` (or the
  Keychain item `codeducky`). Start Claude Code with
  `claude --dangerously-load-development-channels plugin:codeducky@codeducky`.
  `CODEDUCKY_CHANNEL_LABEL` names the session in the PWA.
- **Pre-push gate.** Blocks `git push` while the branch has open blocker or issue notes or unticked
  required checklist items, and fails open. Store an API token in the Keychain
  (`security add-generic-password -U -s codeducky -a "$USER" -w`), then install
  `<CODEDUCKY_PUBLIC_URL>/gate/pre-push.sh` as `.git/hooks/pre-push`, or
  `<CODEDUCKY_PUBLIC_URL>/gate/claude-code-hook.sh` as a Claude Code `PreToolUse` hook.
