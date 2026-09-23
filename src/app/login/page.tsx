import { count } from 'drizzle-orm';
import { db } from '@/db';
import { user } from '@/db/schema';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

const LoginPage = async () => {
  const [{ value }] = await db.select({ value: count() }).from(user);
  return (
    <div className="auth-page">
      <LoginForm isFirstRun={value === 0} />
    </div>
  );
};

export default LoginPage;
