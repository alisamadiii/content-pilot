// TLS decision for the Postgres client, pure so it can be unit-tested:
//  - DATABASE_SSL=require|true / disable|false overrides everything,
//  - then an explicit sslmode in the URL,
//  - otherwise require TLS only for hosts with a dotted domain (managed
//    Postgres like Neon: ep-xxx.aws.neon.tech) — internal Docker/Coolify
//    hosts are single-label and speak plaintext.
export const needsSsl = (
  connectionString: string,
  override: string | undefined = process.env.DATABASE_SSL
): boolean => {
  const o = override?.toLowerCase();
  if (o === 'require' || o === 'true') return true;
  if (o === 'disable' || o === 'false') return false;
  if (/[?&]sslmode=require/.test(connectionString)) return true;
  if (/[?&]sslmode=disable/.test(connectionString)) return false;
  try {
    const host = new URL(connectionString).hostname;
    return host.includes('.') && host !== '127.0.0.1';
  } catch {
    return false;
  }
};
