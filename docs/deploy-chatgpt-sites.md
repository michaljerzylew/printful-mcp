# Deploy on ChatGPT Sites

ChatGPT Sites hosts web apps and MCP servers inside ChatGPT. This project uses the official `@openai/create-sites` layout (`.openai/hosting.json`, vinext on Cloudflare Workers), so Sites can publish it unchanged.

## 1. Publish

1. Download `printful-mcp-<version>.zip` from the [latest release](https://github.com/michaljerzylew/printful-mcp/releases/latest).
2. Open ChatGPT → **Work** (web) or **Codex** (desktop app).
3. Attach the zip and send:

   ```text
   @Sites publish this existing project as a site without changing the code.
   It is a vinext / Cloudflare Workers app built from the official create-sites template, with an MCP server at /mcp.
   ```

4. Review the preview, then publish. Keep the audience **private to you** unless teammates need it.

## 2. Add secrets

Site → **More actions → Settings → Environment variables & secrets**:

| Key | Value |
|---|---|
| `PRINTFUL_API_TOKEN` | your Printful private token |
| `PRINTFUL_STORE_ID` | your Manual/API store id |
| `MCP_API_KEY` | output of `openssl rand -hex 32` |

Optional: `SKU_MAPPING_JSON`, `PACKING_SLIP_JSON`, `MAX_AUTO_CONFIRM_COST`, `DEFAULT_*`. See the README configuration table.

Publish again so the values apply, then open `https://<your-site>/healthz`. Every flag you set should read `true`.

## 3. Connect to ChatGPT

**Easiest:** in the Site's chat, ask *"Turn this Site's MCP server into a plugin and install it for me."*

**Manual:** ChatGPT **Settings → Apps & Connectors → Advanced → Developer mode**, then **Create**:

- MCP server URL: `https://<your-site>/mcp`
- Authentication: API key / Bearer → your `MCP_API_KEY`

If the dialog only offers OAuth or *No authentication*, choose *No authentication* and use
`https://<your-site>/mcp?key=<MCP_API_KEY>`. Treat that URL as a secret and rotate the key if it leaks.

Workspace-only Sites can also admit signed-in teammates without a key. Set `TRUST_SITES_IDENTITY=true` and
`ALLOWED_EMAILS=a@x.com,b@x.com`. Only do this on Sites, which sets the identity header itself.

## 4. Load the skill (optional)

The server already serves the skill via MCP. If your workspace supports uploading skills, you can also upload
`printful-fulfillment-skill.zip` from the release for an always-on copy.

## 5. Try it

> Use Printful: what does a black Bella+Canvas 3001 in M with front and back print cost to make and ship to Poland,
> and what should I charge at a 40% margin incl. 23% VAT?

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Missing or invalid API key` | The key in the connector differs from `MCP_API_KEY`, or the secret was added without republishing. |
| `requires store_id` | Set `PRINTFUL_STORE_ID` or ask the agent to run `printful_stores_list` and pass `store_id`. |
| `Site secret PRINTFUL_API_TOKEN is not set` | Add the secret and publish again. |
| Estimates stay pending | Printful's v2 estimation tasks can be slow; the server falls back to the synchronous v1 estimate after ~20 s. |
