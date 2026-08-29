// ============================================================================
// api/diagnostico.js
// Diz QUAL projeto/repositório está atendendo o domínio e QUAIS variáveis de
// ambiente ele enxerga. Nunca mostra o valor das variáveis — só se existem.
//
// Abra no navegador:  https://saovicente.oticasidealize.online/api/diagnostico
//
// APAGUE ESTE ARQUIVO depois que o WhatsApp estiver funcionando.
// ============================================================================

const ESPERADAS = [
  'ZAPI_INSTANCE',
  'ZAPI_TOKEN',
  'ZAPI_CLIENT_TOKEN',
  'SB_URL',
  'SB_SERVICE_KEY',
  'LOJA_UNIDADE',
  'LOJA_NOME',
  'ORIGENS',
];

module.exports = (req, res) => {
  const variaveis = {};
  for (const nome of ESPERADAS) {
    const v = process.env[nome];
    if (!v) {
      variaveis[nome] = 'FALTANDO';
    } else if (v !== v.trim()) {
      // erro clássico: espaço colado junto no copiar/colar
      variaveis[nome] = `PRESENTE (${v.length} caracteres) — ATENÇÃO: tem espaço sobrando no começo ou no fim`;
    } else {
      variaveis[nome] = `ok (${v.length} caracteres)`;
    }
  }

  const faltando = ESPERADAS.filter(n => !process.env[n]);

  res.status(200).json({
    // é aqui que se descobre o projeto errado:
    projeto: {
      repositorio: process.env.VERCEL_GIT_REPO_SLUG || '(desconhecido)',
      dono: process.env.VERCEL_GIT_REPO_OWNER || '(desconhecido)',
      branch: process.env.VERCEL_GIT_COMMIT_REF || '(desconhecido)',
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || '(desconhecido)',
      ambiente: process.env.VERCEL_ENV || '(fora da Vercel)',
      url_deploy: process.env.VERCEL_URL || '(desconhecida)',
    },
    dominio_chamado: req.headers.host || '(desconhecido)',
    variaveis,
    resumo: faltando.length
      ? `Faltam ${faltando.length}: ${faltando.join(', ')}`
      : 'Todas as 8 variáveis estão presentes.',
    proximo_passo: faltando.length
      ? 'Confira se você criou as variáveis NESTE projeto (veja "repositorio" acima), '
        + 'marcadas em Production, e se fez Redeploy depois de salvar.'
      : 'Configuração completa. Pode testar o envio pelo botão verde.',
  });
};
