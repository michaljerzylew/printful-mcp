import { env } from 'cloudflare:workers';
import { handleOAuthMcp } from '@/lib/mcp';

export const dynamic = 'force-dynamic';

// Per-user endpoint: OAuth access token → that user's encrypted Printful token (see lib/oauth.ts).
const handle = (req: Request) => handleOAuthMcp(req, env as unknown as Record<string, unknown>);

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
