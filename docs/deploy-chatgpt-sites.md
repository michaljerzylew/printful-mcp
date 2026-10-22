# Deploy on ChatGPT Sites

ChatGPT Sites hosts web apps and MCP servers inside ChatGPT. This project uses the official `@openai/create-sites` layout
(`.openai/hosting.json`, vinext on Cloudflare Workers, D1 for connections), so Sites can publish it unchanged.

## Two endpoints, pick the right one

| Endpoint | Auth | Use it for |
|---|---|---|
| **`/api/printful/mcp`** | **OAuth 2.1** (DCR + PKCE S256). Each user types their own Printful token into a connection screen. | **ChatGPT plugins / connectors.** Recommended. |
| `/mcp` | One shared `MCP_API_KEY` and a server-wide `PRINTFUL_API_TOKEN` | Your own scripts and clients that send headers (Claude Code, Cursor, SDK) |

> [!IMPORTANT]
> The plugin Sites creates automatically talks to `/mcp`. ChatGPT cannot send a custom API-key header there, so tool calls
> fail with *"Missing or invalid API key"*. For ChatGPT, always connect the **OAuth endpoint `/api/printful/mcp`**.
> This is what broke early installs before 1.2.0.

## 1. Publish

1. Download `printful-mcp-<version>.zip` from the [latest release](https://github.com/michaljerzylew/printful-mcp/releases/latest).
2. Open ChatGPT → **Work** (web) or **Codex** (desktop app), attach the zip and send:

   ```text
   @Sites publish this existing project as a site without changing the code.
   It is a vinext / Cloudflare Workers app from the official create-sites template, with a D1 database (binding DB,
   migrations in drizzle/) and an MCP server with OAuth at /api/printful/mcp.
   ```

3. Review the preview, then publish. Keep the Site private to you or your workspace.

## 2. Add secrets

Site → **More actions → Settings → Environment variables & secrets**:

| Key | Value | Needed for |
|---|---|---|
| `CONNECTOR_ENCRYPTION_KEY` | `openssl rand -base64 32` (exactly 32 bytes) | OAuth: encrypts every stored Printful token. **Never change it after users connect.** |
| `PUBLIC_ORIGIN` | `https://<your-site>.chatgpt.site` | OAuth: stable issuer and resource URLs |
| `MCP_API_KEY` | `openssl rand -hex 32` | `/mcp` only |
| `PRINTFUL_API_TOKEN`, `PRINTFUL_STORE_ID` | your token and store | `/mcp` only. **Never** used by the OAuth endpoint. |

Publish again so the values apply. Check `https://<your-site>/.well-known/oauth-authorization-server`: `issuer` must equal `PUBLIC_ORIGIN`.

## 3. Connect in ChatGPT

**Settings → Apps & Connectors → Advanced → Developer mode → Create** (or *Plugins → Add MCP server*):

- MCP server URL: `https://<your-site>/api/printful/mcp`
- Authentication: **OAuth** (dynamic client registration; leave client id/secret empty)

Click **Connect**. ChatGPT opens the connection screen:

1. Paste a Printful private token ([developers.printful.com/tokens](https://developers.printful.com/tokens)).
2. Tick the consent box and press **Connect**.

The server checks the token with Printful, encrypts it and sends ChatGPT back a connector token. ChatGPT never sees your
Printful token.

Each person who connects uses **their own** Printful account. Revoke a connection in ChatGPT, or delete the token at Printful.

Optional: a ready plugin manifest template is in [`plugin/`](../plugin). Replace `YOUR-SITE` with your origin.

## 4. Load the skill (optional)

The server already serves the skill via MCP. If your workspace supports uploading skills, you can also upload
`printful-fulfillment-skill.zip` from the release.

## 5. Try it

> Use Printful: what does a black Bella+Canvas 3001 in M with front and back print cost to make and ship to Poland,
> and what should I charge at a 40% margin incl. 23% VAT?

## Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid_request: Unsupported authorization parameter` | You run a build older than 1.2.0. ChatGPT adds `ui_locales`; 1.2.0 ignores unknown optional OAuth parameters (RFC 6749 §3.1). |
| `This callback URL is not allowed` | Only ChatGPT callbacks are accepted by default. For Claude add `OAUTH_REDIRECT_ORIGINS=chatgpt,claude`. |
| `OAuth is not configured` (503) | The D1 binding `DB` or `CONNECTOR_ENCRYPTION_KEY` is missing. Check `.openai/hosting.json` and the Site secrets. |
| `Missing or invalid API key` from ChatGPT | You connected `/mcp`. Use `/api/printful/mcp`. |
| `Printful rejected this API token` on the connection screen | The token is wrong, revoked or lacks scopes. Create a new one with the scopes you need. |
| `requires store_id` | Tell the agent your store, or ask it to call `printful_stores_list` and pass `store_id`. |
| `file URL is not a valid URL` | The design is hosted on a Printful domain (catalog/product images) or is not public. Use your own public file URL. |
| Estimates stay pending | Printful's v2 estimation tasks can be slow; the server falls back to the synchronous v1 estimate after ~20 s. |
| Everyone must reconnect after a redeploy | `CONNECTOR_ENCRYPTION_KEY` changed or D1 was reset. Keep both stable. |
