const API_URL = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:3001';

/** `motivo`: código que o servidor manda quando uma regra barrou a ação (ex.: "proximo_contato"). */
export interface ApiError extends Error { status: number; motivo?: string }

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
