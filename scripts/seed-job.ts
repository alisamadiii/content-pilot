import 'dotenv/config';
import { db, client } from '../src/db';
import { job } from '../src/db/schema';

/**
 * Inserts a mock job for local testing.
 * Usage: pnpm seed [repoId] [owner] [repo] [branch] ["prompt"]
 */
const main = async () => {
  const [, , repoIdArg, owner, repoName, branch, ...promptParts] = process.argv;

  const repoId = Number(repoIdArg);
  if (!repoId || !owner || !repoName) {
    console.log('Usage: pnpm seed <repoId> <owner> <repo> [branch] ["prompt..."]');
    console.log(
      'Tip: get the repoId with: gh api repos/<owner>/<repo> --jq .id'
    );
    process.exit(1);
  }

  const targetBranch = branch || 'main';
  const prompt =
    promptParts.join(' ') ||
    'Change the hero headline to "Welcome to my portfolio"';

  const [created] = await db
    .insert(job)
    .values({
      repoId,
      owner,
      repo: repoName,
      branch: targetBranch,
      prompt,
      requesterId: 'local-seed',
      requestedBy: 'seed-script',
    })
    .returning({ id: job.id });

  console.log(`Seeded job #${created.id}: ${owner}/${repoName} — "${prompt}"`);
  await client.end();
};

main();
