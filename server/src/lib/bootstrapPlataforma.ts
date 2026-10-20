import bcrypt from 'bcryptjs';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { adminsPlataforma, imobiliarias } from '../db/schema.js';

/** Garante o admin da plataforma de PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD a cada inicialização:
 *  cria se ainda não existe e, se já existe com outra senha, atualiza pra senha da variável. Assim
 *  trocar as variáveis no servidor (e reiniciar) é o jeito de definir/recuperar esse acesso.
 *  Outros admins já cadastrados não são mexidos. */
export async function bootstrapAdminPlataforma() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const senha = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !senha) return;

  const [atual] = await db.select().from(adminsPlataforma).where(eq(adminsPlataforma.email, email)).limit(1);
  if (!atual) {
    await db.insert(adminsPlataforma).values({
      nome: process.env.PLATFORM_ADMIN_NAME || 'Administrador',
      email,
      senhaHash: await bcrypt.hash(senha, 10),
    });
    console.log('Plataforma: admin criado —', email);
    return;
  }
  if (!(await bcrypt.compare(senha, atual.senhaHash))) {
    await db.update(adminsPlataforma).set({ senhaHash: await bcrypt.hash(senha, 10) }).where(eq(adminsPlataforma.id, atual.id));
    console.log('Plataforma: senha do admin atualizada pela variável —', email);
  }
}

/** Bloqueia automaticamente imobiliárias ativas cujo vencimento passou + a carência delas,
 *  marcando o motivo como 'inadimplencia'. Registrar um pagamento reativa. */
export async function varrerInadimplencia() {
  const hoje = new Date().toISOString().slice(0, 10);
  const bloqueadas = await db
    .update(imobiliarias)
    .set({ status: 'bloqueada', bloqueioMotivo: 'inadimplencia' })
    .where(and(
      eq(imobiliarias.status, 'ativa'),
      isNotNull(imobiliarias.proximoVencimento),
      sql`(${imobiliarias.proximoVencimento}::date + ${imobiliarias.diasCarencia} * interval '1 day') < ${hoje}::date`,
    ))
    .returning({ id: imobiliarias.id, nome: imobiliarias.nome });
  if (bloqueadas.length) {
    console.log('Plataforma: bloqueadas por inadimplência —', bloqueadas.map(b => b.nome).join(', '));
  }
  return bloqueadas.length;
}
