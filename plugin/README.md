# ChatGPT plugin package

Template for packaging the OAuth endpoint as a ChatGPT / Codex plugin. Replace `YOUR-SITE.chatgpt.site` with your deployment
origin (the value of `PUBLIC_ORIGIN`) in `mcp.json`, then add the `skills/printful-fulfillment` folder from the repository root
next to these files:

```
printful-mcp/
├── plugin.json
├── mcp.json
└── skills/printful-fulfillment/…
```

Most users don't need this: ChatGPT Sites can create and install the plugin for you (see `docs/deploy-chatgpt-sites.md`).
