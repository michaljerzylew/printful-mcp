import { env } from 'cloudflare:workers';
import { handleHttp } from '@/lib/mcp';

export const dynamic = 'force-dynamic';

const handle = (req: Request) => handleHttp(req, env as unknown as Record<string, unknown>);

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
