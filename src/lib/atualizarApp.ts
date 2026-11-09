/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from 'virtual:pwa-register';

/** Mantém o CRM sempre na versão do ar, mesmo pra quem deixa a aba/app aberto por dias.
 *  Antes o navegador só procurava versão nova ao recarregar a página — o gerente ficou 2 dias com a versão
 *  antiga aberta (erros já corrigidos continuavam aparecendo). Agora confere ao voltar pra tela e a cada 30 min;
 *  achou versão nova → recarrega sozinho (registerType 'autoUpdate'). */
export function manterAppAtualizado() {
  if (!('serviceWorker' in navigator)) return;
  registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const conferir = () => { if (navigator.onLine) reg.update().catch(() => {}); };
      // ao voltar pra tela: ninguém está no meio de digitar, é a hora certa de trocar a versão
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') conferir(); });
      // aba sempre visível (monitor do plantão): confere a cada 30 min
      setInterval(conferir, 30 * 60 * 1000);
    },
  });
}
