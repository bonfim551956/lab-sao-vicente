// ============================================================================
// Conciliação do caixa com o extrato — Óticas Idealize
//
// Recebe o que o sistema registrou numa forma de pagamento e o extrato colado
// pelo operador, e devolve o que bateu, o que sobrou de cada lado e o provável
// motivo da diferença.
//
// A chave da IA NUNCA vai para o HTML: fica aqui, nas variáveis da Vercel.
//
// Variáveis necessárias (Vercel > Settings > Environment Variables):
//   ANTHROPIC_API_KEY   a chave da API, criada em console.anthropic.com
//
// A IA apenas SUGERE. Quem confirma a conferência é o operador.
// ============================================================================

const MODELO = 'claude-sonnet-4-6';
const MAX_EXTRATO = 60000;   // caracteres; extrato maior que isso é cortado

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Use POST.' });
  }

  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) {
    return res.status(500).json({
      erro: 'Falta a variável ANTHROPIC_API_KEY nas configurações da Vercel.',
    });
  }

  try {
    const { forma, data, lancamentos, extrato } = req.body || {};

    if (!forma || !extrato) {
      return res.status(400).json({ erro: 'Informe a forma de pagamento e o extrato.' });
    }

    const linhas = Array.isArray(lancamentos) ? lancamentos : [];
    const totalSistema = linhas.reduce((s, l) => s + (Number(l.valor) || 0), 0);
    const texto = String(extrato).slice(0, MAX_EXTRATO);

    const prompt =
`Você confere o caixa de uma ótica. Compare o que o sistema registrou com o extrato.

FORMA DE PAGAMENTO: ${forma}
DATA: ${data || '(não informada)'}

LANÇAMENTOS DO SISTEMA (${linhas.length}, total R$ ${totalSistema.toFixed(2)}):
${linhas.map(l => `- OS ${l.os || '-'} | ${l.cliente || '-'} | R$ ${Number(l.valor || 0).toFixed(2)}`).join('\n') || '(nenhum)'}

EXTRATO COLADO PELO OPERADOR:
${texto}

Responda SOMENTE com um objeto JSON, sem markdown e sem texto fora dele:
{
  "totalExtrato": number,
  "totalSistema": number,
  "diferenca": number,
  "bateu": boolean,
  "conciliados": [{"os":"","valor":0}],
  "soNoExtrato": [{"descricao":"","valor":0}],
  "soNoSistema": [{"os":"","valor":0}],
  "provavelMotivo": "",
  "resumo": ""
}

Regras:
- Valores em número, ponto decimal, sem "R$".
- "diferenca" = totalExtrato - totalSistema.
- Considere taxas de maquininha, pagamento que cai no dia seguinte, valor
  lançado trocado e venda que não foi registrada como motivos possíveis.
- "resumo" em uma frase curta, em português do Brasil.
- Se o extrato não tiver valores reconhecíveis, devolva bateu=false e explique
  em "resumo".`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': chave,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const dados = await r.json();
    if (!r.ok) {
      return res.status(502).json({
        erro: (dados && dados.error && dados.error.message) || 'A IA não respondeu.',
      });
    }

    const bruto = (dados.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    let resultado;
    try {
      resultado = JSON.parse(bruto);
    } catch (e) {
      return res.status(502).json({
        erro: 'A IA respondeu num formato inesperado.',
        bruto: bruto.slice(0, 400),
      });
    }

    // o total do sistema é nosso, não da IA
    resultado.totalSistema = Math.round(totalSistema * 100) / 100;
    resultado.totalExtrato = Math.round((Number(resultado.totalExtrato) || 0) * 100) / 100;
    resultado.diferenca = Math.round((resultado.totalExtrato - resultado.totalSistema) * 100) / 100;
    resultado.bateu = Math.abs(resultado.diferenca) < 0.01;

    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao conciliar: ' + err.message });
  }
};
