import { asc, desc } from 'drizzle-orm';
import { db } from '@/db';
import { domain, repo } from '@/db/schema';
import {
  AddDomainForm,
  RegisterSiteForm,
  RemoveDomainButton,
} from './domains-client';

export const dynamic = 'force-dynamic';

const DomainsPage = async () => {
  const repos = await db
    .select({
      repoId: repo.repoId,
      owner: repo.owner,
      repo: repo.repo,
      branch: repo.branch,
    })
    .from(repo)
    .orderBy(desc(repo.updatedAt));

  const domains = await db
    .select({
      id: domain.id,
      origin: domain.origin,
      repoId: domain.repoId,
    })
    .from(domain)
    .orderBy(asc(domain.origin));

  const byRepo = new Map<number, typeof domains>();
  for (const row of domains) {
    const list = byRepo.get(row.repoId) ?? [];
    list.push(row);
    byRepo.set(row.repoId, list);
  }

  return (
    <>
      <h1>domains</h1>
      <p className="subtitle">
        whitelisted origins for the public edit intake — an origin maps to
        exactly one site
      </p>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>register a site</div>
        <RegisterSiteForm />
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          The repo is cloned lazily on its first edit — registering here only
          records the site and its allowed origins.
        </div>
      </div>

      {repos.length === 0 ? (
        <div className="card muted">
          No sites yet. Register one above so its edit requests are accepted.
        </div>
      ) : (
        repos.map((site) => {
          const list = byRepo.get(site.repoId) ?? [];
          return (
            <div className="card" key={site.repoId}>
              <div
                className="row"
                style={{ justifyContent: 'space-between', marginBottom: 10 }}
              >
                <div>
                  <a
                    href={`https://github.com/${site.owner}/${site.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontWeight: 600 }}
                  >
                    {site.owner}/{site.repo}
                  </a>
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    #{site.repoId} · {site.branch}
                  </span>
                </div>
              </div>

              {list.length === 0 ? (
                <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                  No domains yet — edit requests from this site will be rejected
                  until you add one.
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  {list.map((d) => (
                    <span
                      key={d.id}
                      className="status status-done"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      {d.origin}
                      <RemoveDomainButton repoId={site.repoId} origin={d.origin} />
                    </span>
                  ))}
                </div>
              )}

              <AddDomainForm repoId={site.repoId} />
            </div>
          );
        })
      )}
    </>
  );
};

export default DomainsPage;
