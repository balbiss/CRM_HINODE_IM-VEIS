import { apiFetch } from './api';

function b64ToBuffer(base64: string): ArrayBuffer {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr.buffer;
}

/** Registra este dispositivo pra receber Web Push (funciona com o CRM fechado / celular bloqueado). */
export async function registrarPush(token: string): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return false;

    const cfg = await apiFetch<{ habilitado: boolean; publicKey: string }>('/api/push/vapid', token).catch(() => null);
    if (!cfg?.habilitado || !cfg.publicKey) return false;

    if (Notification.permission === 'denied') return false;
    if (Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') return false;
    }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // Se a chave do servidor mudou, a inscrição antiga não recebe mais nada: refaz com a chave atual.
    if (sub) {
      const atual = sub.options?.applicationServerKey;
      const nova = new Uint8Array(b64ToBuffer(cfg.publicKey));
      const igual = !!atual && atual.byteLength === nova.byteLength && new Uint8Array(atual).every((b, i) => b === nova[i]);
      if (!igual) { await sub.unsubscribe().catch(() => {}); sub = null; }
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToBuffer(cfg.publicKey),
      });
    }
    const j = sub.toJSON();
    await apiFetch('/api/push/subscribe', token, {
      method: 'POST',
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
    });
    return true;
  } catch {
    return false;
  }
}
