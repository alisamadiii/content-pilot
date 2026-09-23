'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export const LoginForm = ({ isFirstRun }: { isFirstRun: boolean }) => {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const result = isFirstRun
      ? await authClient.signUp.email({ email, password, name: name || 'Admin' })
      : await authClient.signIn.email({ email, password });
    setLoading(false);
    if (result.error) {
      setError(result.error.message || 'Authentication failed');
      return;
    }
    router.push('/jobs');
    router.refresh();
  };

  return (
    <form className="auth-box" onSubmit={submit}>
      <div className="brand" style={{ fontSize: 18, fontWeight: 700 }}>
        content<span style={{ color: 'var(--accent)' }}>-pilot</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {isFirstRun
          ? 'First run — create the admin account.'
          : 'Sign in to the dashboard.'}
      </p>
      {isFirstRun && (
        <input
          type="text"
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      )}
      <input
        type="email"
        placeholder="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        type="password"
        placeholder="password"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="error-text">{error}</div>}
      <button className="primary" type="submit" disabled={loading}>
        {loading ? '...' : isFirstRun ? 'Create admin account' : 'Sign in'}
      </button>
    </form>
  );
};
