import jwt from 'jsonwebtoken';

export interface JwtClaims {
  sub: string; // perfil id
  imobiliariaId: string;
  role: 'dono' | 'gerente' | 'corretor';
  nome: string;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET não configurada (veja server/.env)');
  return secret;
}

// Sessão da equipe: 30 dias, renovada sozinha toda vez que o app abre/volta pro foco (GET /api/auth/me devolve token novo).
// Antes era 8h: o corretor deixava o CRM aberto de um dia pro outro e tudo falhava com 'Token inválido ou expirado'.
// Bloquear alguém em Equipe corta na hora (requireAuth confere perfis.bloqueado a cada request).
export function signToken(claims: JwtClaims): string {
  const options: jwt.SignOptions = { expiresIn: '30d' };
  return jwt.sign(claims, getSecret(), options);
}

export function verifyToken(token: string): JwtClaims {
  return jwt.verify(token, getSecret()) as unknown as JwtClaims;
}

// --- Painel Dono do SaaS (admin de plataforma) ---

export interface PlatformClaims {
  sub: string; // admins_plataforma id
  nome: string;
  scope: 'plataforma';
}

export function signPlatformToken(claims: Omit<PlatformClaims, 'scope'>): string {
  const options: jwt.SignOptions = { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as jwt.SignOptions['expiresIn'] };
  return jwt.sign({ ...claims, scope: 'plataforma' }, getSecret(), options);
}

export function verifyPlatformToken(token: string): PlatformClaims {
  const claims = jwt.verify(token, getSecret()) as unknown as PlatformClaims;
  if (claims.scope !== 'plataforma') throw new Error('Token não é de plataforma');
  return claims;
}
