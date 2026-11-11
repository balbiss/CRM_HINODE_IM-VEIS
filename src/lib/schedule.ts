// Janela de atendimento por dia da semana (minutos desde meia-noite, fuso São Paulo).
// Índice 0 = domingo … 6 = sábado. Configurável pelo Dono/Gerente em Ajustes.
export interface DiaAtendimento { ativo: boolean; abreMin: number; fechaMin: number }

export const HORARIO_ATENDIMENTO_PADRAO: DiaAtendimento[] = [
  { ativo: false, abreMin: 8 * 60, fechaMin: 18 * 60 },
  { ativo: true, abreMin: 8 * 60, fechaMin: 18 * 60 + 20 },
  { ativo: true, abreMin: 8 * 60, fechaMin: 18 * 60 + 20 },
  { ativo: true, abreMin: 8 * 60, fechaMin: 18 * 60 + 20 },
  { ativo: true, abreMin: 8 * 60, fechaMin: 19 * 60 + 20 },
  { ativo: true, abreMin: 8 * 60, fechaMin: 18 * 60 + 20 },
  { ativo: true, abreMin: 8 * 60, fechaMin: 15 * 60 + 20 },
];

export const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export const minToHHMM = (min: number) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
export const hhmmToMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };

export function isBusinessHoursOpen(dias: DiaAtendimento[] = HORARIO_ATENDIMENTO_PADRAO, agora = new Date()): boolean {
  const cfg = dias.length === 7 ? dias : HORARIO_ATENDIMENTO_PADRAO;
  // sempre no fuso de São Paulo — independe do fuso do navegador
  const d = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hoje = cfg[d.getDay()];
  if (!hoje || !hoje.ativo) return false;
  const min = d.getHours() * 60 + d.getMinutes();
  return min >= hoje.abreMin && min < hoje.fechaMin;
}

/** Expediente da ROLETA (mesma regra do servidor, roletaOka.ts): seg–sex até 18:20, quinta até 19:30,
 *  sábado até 15:20, domingo fechado. É diferente do horário de atendimento da equipe (Ajustes). */
export function expedienteRoletaAberto(agora = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(agora).map(x => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  if (dow === 0) return false;
  const min = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return min < (dow === 4 ? 19 * 60 + 30 : dow === 6 ? 15 * 60 + 20 : 18 * 60 + 20);
}

export function horarioAtendimentoLabel(dias: DiaAtendimento[] = HORARIO_ATENDIMENTO_PADRAO): string {
  const cfg = dias.length === 7 ? dias : HORARIO_ATENDIMENTO_PADRAO;
  const partes = cfg
    .map((c, i) => (c.ativo ? DIAS_SEMANA[i].slice(0, 3) + ' ' + minToHHMM(c.abreMin) + '–' + minToHHMM(c.fechaMin) : null))
    .filter(Boolean);
  return 'Fora do horário de atendimento da equipe' + (partes.length ? ' (' + partes.join(', ') + ')' : '') + '.';
}
