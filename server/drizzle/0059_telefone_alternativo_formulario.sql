-- 2026-11-12 (pedido do dono): o formulário da Meta tem "confirme o seu telefone". A v1 guarda esse 2º
-- número como telefone alternativo; a v2 deixava só no histórico ("Respostas do formulário: ...").
-- Preenche o alternativo dos leads que já entraram, quando o número é diferente do principal
-- (últimos 8 dígitos) e o card ainda não tem alternativo.
UPDATE "leads" l
SET "telefone_alternativo" = x.numero
FROM (
  SELECT DISTINCT ON (e.lead_id) e.lead_id,
    regexp_replace(substring(e.descricao from '(?i)confirme o seu telefone: *([0-9 ()+.-]{10,20})'), '\D', '', 'g') AS numero
  FROM "eventos_lead" e
  WHERE e.tipo = 'formulario' AND e.descricao ~* 'confirme o seu telefone: *[0-9]'
  ORDER BY e.lead_id, e.criado_em DESC
) x
WHERE l.id = x.lead_id
  AND coalesce(l.telefone_alternativo, '') = ''
  AND length(x.numero) BETWEEN 10 AND 13
  AND right(x.numero, 8) <> right(regexp_replace(l.telefone, '\D', '', 'g'), 8);
