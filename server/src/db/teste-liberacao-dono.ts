/** Teste das regras "dono liga corretor fora do expediente" + check-in, com relógio controlado.
 *  Roda contra um banco de TESTE: DATABASE_URL=... npx tsx src/db/teste-liberacao-dono.ts */
import { eq, inArray } from 'drizzle-orm';
import { db, sql as cliente } from './client.js';
import { perfis, filasAtendimento } from './schema.js';
import { expedienteAberto, liberarForaDoExpediente, proximoDaFilaOka, desligarFimDeExpediente, entrarNaRoleta, fimDoDiaSp } from '../lib/roletaOka.js';

let ok = 0, falha = 0;
const conf = (nome: string, obtido: unknown, esperado: unknown) => {
  const bate = JSON.stringify(obtido) === JSON.stringify(esperado);
  bate ? ok++ : falha++;
  console.log((bate ? '  OK    ' : '  FALHA ') + nome + (bate ? '' : `  → obtido ${JSON.stringify(obtido)} esperado ${JSON.stringify(esperado)}`));
};
const io = { to: () => ({ emit: () => true }) } as any;
const sp = (iso: string) => new Date(iso + '-03:00');

async function main() {
  if (!/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL ?? '')) throw new Error('Só roda em banco local de teste');
  const [diego] = await db.select().from(perfis).where(eq(perfis.email, 'diego.antunes@novaimob.com.br'));
  const [fer] = await db.select().from(perfis).where(eq(perfis.email, 'fernanda.lopes@novaimob.com.br'));
  const [fila] = await db.select().from(filasAtendimento).where(eq(filasAtendimento.corretorId, diego.id));
  const roletaId = fila.roletaId!;
  await db.update(perfis).set({ emPlantao: false, emAlmoco: false, plantaoLiberadoAte: null, advertenciasSemana: 0 }).where(eq(perfis.imobiliariaId, diego.imobiliariaId));
  await db.update(filasAtendimento).set({ ativoNoTurno: true }).where(inArray(filasAtendimento.corretorId, [diego.id, fer.id]));

  const noite = sp('2026-11-02T21:00:00');          // segunda, 21h (roleta fecha 18:20)
  console.log('\n== Segunda 21:00 (fora do expediente) ==');
  conf('Expediente fechado às 21h', expedienteAberto(noite), false);
  conf('Ninguém liberado → roleta não entrega', await proximoDaFilaOka(roletaId, noite), null);

  const ate = await liberarForaDoExpediente(diego.id, noite);
  conf('Liberação vale até 00:00 de terça (Brasília)', ate.toISOString(), '2026-11-03T03:00:00.000Z');
  const [d1] = await db.select().from(perfis).where(eq(perfis.id, diego.id));
  conf('Diego online', d1.emPlantao, true);
  conf('Check-in gravado às 21:00', d1.checkinEm?.toISOString(), noite.toISOString());
  conf('Sem advertência (foi o dono)', d1.advertenciasSemana, 0);

  // Fernanda "esquecida" online sem liberação
  await db.update(perfis).set({ emPlantao: true }).where(eq(perfis.id, fer.id));
  conf('Roleta entrega só pro liberado (Diego)', await proximoDaFilaOka(roletaId, noite), diego.id);

  await desligarFimDeExpediente(io, sp('2026-11-02T21:01:00'));
  const [d2] = await db.select().from(perfis).where(eq(perfis.id, diego.id));
  const [f2] = await db.select().from(perfis).where(eq(perfis.id, fer.id));
  conf('Robô do fim do expediente NÃO derruba o Diego', d2.emPlantao, true);
  conf('Robô derruba a Fernanda (sem liberação)', f2.emPlantao, false);

  console.log('\n== Terça 00:05 (liberação venceu) ==');
  await desligarFimDeExpediente(io, sp('2026-11-03T00:05:00'));
  const [d3] = await db.select().from(perfis).where(eq(perfis.id, diego.id));
  conf('Diego sai da roleta à meia-noite', d3.emPlantao, false);
  conf('Liberação limpa', d3.plantaoLiberadoAte, null);

  console.log('\n== Terça 10:00 (dentro do expediente) ==');
  const manha = sp('2026-11-03T10:00:00');
  conf('Expediente aberto às 10h', expedienteAberto(manha), true);
  const r = await entrarNaRoleta(fer.id, manha);
  const [f3] = await db.select().from(perfis).where(eq(perfis.id, fer.id));
  conf('Fernanda entra sem advertência', [r.ativo, r.atrasado], [true, false]);
  conf('Check-in da Fernanda às 10:00', f3.checkinEm?.toISOString(), manha.toISOString());
  conf('Roleta normal entrega pra Fernanda', await proximoDaFilaOka(roletaId, manha), fer.id);
  conf('fimDoDiaSp no domingo', fimDoDiaSp(sp('2026-11-08T22:00:00')).toISOString(), '2026-11-09T03:00:00.000Z');

  await db.update(perfis).set({ emPlantao: false, plantaoLiberadoAte: null }).where(eq(perfis.imobiliariaId, diego.imobiliariaId));
  console.log(`\nRESULTADO: ${ok} ok, ${falha} falha(s)`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => cliente.end());
