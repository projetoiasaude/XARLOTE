'use client';
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // hard nav pra o middleware reavaliar o cookie já setado
        window.location.href = next.startsWith('/') ? next : '/';
        return;
      }
      if (res.status === 401) setError('Senha incorreta.');
      else if (res.status === 503) setError('Login ainda não configurado no servidor.');
      else setError('Não foi possível entrar. Tente de novo.');
    } catch {
      setError('Erro de conexão.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm">
      <div className="glass glass-spec rounded-3xl p-8 border border-white/10">
        <div className="mb-6 text-center">
          <div className="text-2xl font-semibold tracking-tight">Xarlote · Admin</div>
          <div className="mt-1 text-sm text-white/40">Acesso restrito ao painel</div>
        </div>

        <label className="block text-xs font-medium text-white/50 mb-2">Senha</label>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-white placeholder-white/25 outline-none focus:border-accent/60 focus:bg-white/8 transition"
        />

        {error && <div className="mt-3 text-sm text-aurora-pink">{error}</div>}

        <button
          type="submit"
          disabled={loading || !password}
          className="mt-6 w-full rounded-xl bg-accent/90 hover:bg-accent text-white font-medium py-3 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="relative h-screen flex items-center justify-center bg-ink-base text-white px-6 overflow-hidden">
      <div className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-aurora-blue/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-aurora-purple/20 blur-3xl" />
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
