import { eq } from 'drizzle-orm';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/db';
import { previewSession } from '@/db/schema';
import { getAppDir } from '@/lib/settings';
import {
  authenticateSessionRequest,
  sessionCorsHeaders,
} from '@/lib/session-auth';
import { repoDir } from '@/worker/git';

type SkillInfo = { name: string; description: string };

/**
 * Minimal SKILL.md frontmatter reader — just `name:` and `description:`
 * between the first `---` pair. Skills are authored by us in client repos, so
 * a full YAML parser is overkill; anything unparseable is skipped.
 */
const parseSkillMd = (path: string): SkillInfo | null => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!fields.name) return null;
  return { name: fields.name, description: fields.description ?? '' };
};

const scanSkillsDir = (base: string): SkillInfo[] => {
  const skillsDir = join(base, '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];
  const found: SkillInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const skill = parseSkillMd(join(skillsDir, entry, 'SKILL.md'));
    if (skill) found.push(skill);
  }
  return found;
};

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

/**
 * Lists the skills available in the session repo's workspace clone (root
 * `.claude/skills/` plus the admin-set app folder's, root winning on name
 * clashes) — powers the hub chat's "/" menu. The clone persists across
 * paused sessions; an empty list just means it hasn't been cloned yet.
 */
export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const { id } = await params;
  const auth = await authenticateSessionRequest(request);
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  const [row] = await db
    .select({ id: previewSession.id, repoId: previewSession.repoId })
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!row) {
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  }
  if (auth.kind === 'edit-token' && auth.payload.repoId !== row.repoId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }

  const dir = repoDir(row.repoId);
  const skills = new Map<string, SkillInfo>();
  const appDir = await getAppDir(row.repoId);
  if (appDir) {
    for (const skill of scanSkillsDir(join(dir, appDir))) {
      skills.set(skill.name, skill);
    }
  }
  for (const skill of scanSkillsDir(dir)) {
    skills.set(skill.name, skill); // root wins
  }
  return Response.json(
    { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)) },
    { status: 200, headers }
  );
};
