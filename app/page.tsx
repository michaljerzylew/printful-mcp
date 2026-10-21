import { SERVER_INFO } from '@/lib/mcp';
import { SKILLS } from '@/lib/skills.generated';
import { TOOLS } from '@/lib/tools';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 font-sans text-zinc-900">
      <h1 className="text-3xl font-semibold">Printful MCP</h1>
      <p className="mt-2 text-zinc-600">
        MCP server v{SERVER_INFO.version} for running Printful print-on-demand fulfillment from ChatGPT. Endpoint:{' '}
        <code className="rounded bg-zinc-100 px-1">/mcp</code> (Streamable HTTP, POST, API key in{' '}
        <code className="rounded bg-zinc-100 px-1">Authorization: Bearer …</code>).
      </p>
      <h2 className="mt-8 text-xl font-semibold">Skills (SEP-2640)</h2>
      <ul className="mt-2 list-disc pl-6">
        {SKILLS.map((s) => (
          <li key={s.name}>
            <code>skill://{s.name}/SKILL.md</code> — {s.frontmatter.description}
          </li>
        ))}
      </ul>
      <h2 className="mt-8 text-xl font-semibold">Tools ({TOOLS.length + 1})</h2>
      <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {TOOLS.map((t) => (
          <li key={t.name} className="text-sm">
            <code>{t.name}</code>
          </li>
        ))}
        <li className="text-sm">
          <code>printful_skill</code>
        </li>
      </ul>
      <p className="mt-8 text-sm text-zinc-500">Health: <code>/healthz</code></p>
    </main>
  );
}
