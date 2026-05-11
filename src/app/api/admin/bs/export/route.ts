import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import { BS_TOPICS, BsEntry } from '@/lib/bs-topics';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

  if (!token || token !== process.env.API_SECRET_KEY) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const lines: string[] = ['# Dossier behind-the-scenes — Mauro Carrillo', ''];
  let totalEntries = 0;

  for (const topic of BS_TOPICS) {
    const entries = (await kv.get<BsEntry[]>(`bs:dossier:${topic.id}`)) || [];
    totalEntries += entries.length;
    lines.push(`## ${topic.label}`);
    lines.push(`*id: \`${topic.id}\` — entradas: ${entries.length}*`);
    lines.push('');

    if (entries.length === 0) {
      lines.push('_(sin respuestas todavía)_');
      lines.push('');
      continue;
    }

    for (const e of entries) {
      lines.push(`### ${e.date.slice(0, 10)}`);
      for (const a of e.answers) {
        if (!a.answer.trim()) continue;
        lines.push(`**${a.question}**`);
        lines.push(a.answer.trim());
        lines.push('');
      }
    }
  }

  lines.unshift(`*Total entradas: ${totalEntries} — generado ${new Date().toISOString()}*`, '');

  return new NextResponse(lines.join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
