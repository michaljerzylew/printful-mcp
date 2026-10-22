import { env } from 'cloudflare:workers';
import { renderAuthorizePage } from '@/lib/authorize-page';
import { handleOAuth, type OAuthEnv } from '@/lib/oauth';

export const dynamic = 'force-dynamic';

const handle = (req: Request) => handleOAuth(req, env as unknown as OAuthEnv, renderAuthorizePage);

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
