const API_URL = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:3001';

/** `motivo`: código que o servidor manda quando uma regra barrou a ação (ex.: "proximo_contato"). */
export interface ApiError extends Error { status: number; motivo?: string }

/** Chamado quando o servidor recusa a sessão (401) — o app volta pra tela de login com aviso,
 *  em vez de seguir aberto e falhar em tudo com "Token inválido ou expirado". */
let aoExpirar: (() => void) | null = null;
export function quandoSessaoExpirar(fn: () => void) { aoExpirar = fn; }

export async function apiFetch<T = unknown>(path: string, token: string | null, options: RequestInit = {}): Promise<T> {
  const res = await fetch(API_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/api/auth/login')) aoExpirar?.();
    const body = await res.json().catch(() => ({}) as { error?: string; motivo?: string });
    const err = new Error(body.error || 'Erro ' + res.status) as ApiError;
    err.status = res.status;
    err.motivo = body.motivo;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export { API_URL };
