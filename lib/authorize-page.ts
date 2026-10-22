// Connection screen shown inside the OAuth flow. Neutral branding on purpose: this is an independent connector, so it must
// not look like a Printful login page. All dynamic values are HTML-escaped; the page ships with a strict CSP (lib/oauth.ts).
import type { AuthorizationView } from './oauth';

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderAuthorizePage(v: AuthorizationView): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Printful · Printful MCP</title><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#0b0f14;--muted:#5c6b7c;--line:#d9dee5;--accent:#ff7a45;--accent2:#ffb547;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--ink:#f0f6fc;--muted:#9aa7b6;--line:#30363d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{min-height:100vh;display:grid;place-items:center;padding:24px 16px}.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:32px;box-shadow:0 20px 60px #0000001a}
.mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;font-weight:800;color:#0b0f14;margin-bottom:16px}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}label{display:block;font-weight:600;margin:18px 0 6px}
input[type=password]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}
.consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;color:var(--muted);font-size:14px}.consent input{margin-top:4px}
button{width:100%;margin-top:20px;padding:12px;border:0;border-radius:10px;background:var(--ink);color:var(--card);font:600 16px/1 inherit;cursor:pointer}
.err{color:var(--err);background:#b423181a;border-radius:10px;padding:10px 12px;margin:0 0 12px}.fine{font-size:13px;margin-top:18px}a{color:inherit}
</style></head><body><main><div class="card">
<div class="mark" aria-hidden="true">P</div>
<h1>Connect your Printful account</h1>
<p><strong>${esc(v.clientName)}</strong> is asking to use Printful on your behalf through Printful MCP.</p>
${v.error ? `<p class="err" role="alert">${esc(v.error)}</p>` : ''}
<form method="post" action="${esc(v.action)}">
<input type="hidden" name="csrf" value="${esc(v.csrf)}">
<label for="t">Printful API token</label>
<input id="t" type="password" name="api_token" required autocomplete="off" spellcheck="false" maxlength="4096" placeholder="Paste a private token">
<label class="consent"><input type="checkbox" name="consent" value="yes" required> I allow this connection to use my Printful token. It is checked with Printful, encrypted and never shown to the AI.</label>
<button type="submit">Connect</button>
</form>
<p class="fine">Create a token at developers.printful.com/tokens. You can revoke this connection anytime in your AI app or by deleting the token at Printful. Independent open-source connector, not affiliated with Printful.</p>
</div></main></body></html>`;
}
