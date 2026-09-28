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
    const { modo, forma, data, lancamentos, extrato, formas } = req.body || {};

    // ── modo "tudo": vários extratos de uma vez, a IA separa por forma ──
    if (modo === 'tudo') {
      return conciliarTudo({ chave, data, formas, extrato }, res);
    }

    // ── modo "periodo": um intervalo de dias contra os extratos ──
    if (modo === 'periodo') {
      return conciliarPeriodo({ chave, extrato, dias: req.body.dias,
                                periodo: req.body.periodo }, res);
    }

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

    let resultado;
  try {
    resultado = await pedirJSON(chave, prompt, 2000);
  } catch (e) {
    return res.status(e.status || 502).json({ erro: e.message, bruto: e.bruto });
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

// ============================================================================
// Conferir várias formas de uma vez. O operador cola tudo o que tem — relatório
// da maquininha, do Asaas, do banco — e a IA separa os lançamentos por forma
// de pagamento antes de comparar.
// ============================================================================
async function conciliarTudo({ chave, data, formas, extrato }, res) {
  const lista = Array.isArray(formas) ? formas : [];
  if (!lista.length) {
    return res.status(400).json({ erro: 'Nenhuma forma de pagamento para conferir.' });
  }
  if (!extrato || !String(extrato).trim()) {
    return res.status(400).json({ erro: 'Cole os extratos ou escolha os arquivos.' });
  }

  const texto = String(extrato).slice(0, MAX_EXTRATO * 2);

  const blocos = lista.map(f => {
    const linhas = Array.isArray(f.lancamentos) ? f.lancamentos : [];
    const total = linhas.reduce((s, l) => s + (Number(l.valor) || 0), 0);
    return `FORMA: ${f.forma} — total R$ ${total.toFixed(2)} em ${linhas.length} lançamento(s)
${linhas.map(l => `  - OS ${l.os || '-'} | ${l.cliente || '-'} | R$ ${Number(l.valor || 0).toFixed(2)}`).join('\n') || '  (nenhum)'}`;
  }).join('\n\n');

  const prompt =
`Você confere o caixa de uma ótica. Compare o que o sistema registrou, separado por forma
de pagamento, com os extratos que o operador colou. Os extratos vêm misturados: podem ser
de maquininha, Asaas, banco ou vários juntos, cada um marcado com o nome do arquivo.

DATA: ${data || '(não informada)'}

O QUE O SISTEMA REGISTROU:
${blocos}

EXTRATOS COLADOS PELO OPERADOR:
${texto}

Responda SOMENTE com um objeto JSON, sem markdown e sem texto fora dele:
{
  "formas": [
    {
      "forma": "nome exatamente como veio na lista acima",
      "totalExtrato": number,
      "encontrado": boolean,
      "soNoExtrato": [{"descricao":"","valor":0}],
      "soNoSistema": [{"os":"","valor":0}],
      "provavelMotivo": "",
      "resumo": ""
    }
  ],
  "naoIdentificado": [{"descricao":"","valor":0}],
  "resumoGeral": ""
}

Regras:
- Uma entrada por forma da lista, usando o nome exato. Não invente formas.
- "encontrado" é false quando os extratos não trazem nada daquela forma; nesse caso
  totalExtrato deve ser 0 e o resumo explica que não foi encontrado.
- Valores em número, ponto decimal, sem "R$".
- "naoIdentificado" recebe o que existe nos extratos e não se encaixa em nenhuma forma.
- Considere taxas de maquininha, pagamento que cai no dia seguinte, valor lançado
  trocado e venda não registrada como motivos possíveis.
- Textos curtos, em português do Brasil.`;

  let out;
  try {
    out = await pedirJSON(chave, prompt, 4000);
  } catch (e) {
    return res.status(e.status || 502).json({ erro: e.message, bruto: e.bruto });
  }

  // os totais do sistema são nossos, não da IA
  const porNome = {};
  lista.forEach(f => {
    const linhas = Array.isArray(f.lancamentos) ? f.lancamentos : [];
    porNome[f.forma] = linhas.reduce((s, l) => s + (Number(l.valor) || 0), 0);
  });

  out.formas = (out.formas || []).map(f => {
    const sistema = Math.round((porNome[f.forma] || 0) * 100) / 100;
    const extratoV = Math.round((Number(f.totalExtrato) || 0) * 100) / 100;
    const dif = Math.round((extratoV - sistema) * 100) / 100;
    return { ...f, totalSistema: sistema, totalExtrato: extratoV, diferenca: dif,
             bateu: Math.abs(dif) < 0.01 };
  });

  return res.status(200).json(out);
}

// ============================================================================
// Conferência de um período. Compara os fechamentos salvos de um intervalo com
// os extratos do mesmo intervalo, e aponta as diferenças DIA A DIA — é onde
// está a informação útil: saber em que dia procurar.
// ============================================================================
async function conciliarPeriodo({ chave, extrato, dias, periodo }, res) {
  const lista = Array.isArray(dias) ? dias : [];
  if (!lista.length) {
    return res.status(400).json({ erro: 'Nenhum fechamento salvo neste período.' });
  }
  if (!extrato || !String(extrato).trim()) {
    return res.status(400).json({ erro: 'Cole os extratos ou escolha os arquivos.' });
  }

  const texto = String(extrato).slice(0, MAX_EXTRATO * 3);

  const porForma = {};
  lista.forEach(d => Object.entries(d.formas || {}).forEach(([f, v]) => {
    porForma[f] = (porForma[f] || 0) + (Number(v) || 0);
  }));
  const totalSistema = Object.values(porForma).reduce((s, v) => s + v, 0);

  const tabela = lista.map(d =>
    `  ${d.data} | caixa R$ ${Number(d.caixa || 0).toFixed(2)} | ` +
    Object.entries(d.formas || {}).map(([f, v]) => `${f} R$ ${Number(v).toFixed(2)}`).join(', ')
  ).join('\n');

  const prompt =
`Você confere o caixa de uma ótica contra os extratos de um período.

PERÍODO: ${periodo || '(não informado)'}

O QUE O SISTEMA REGISTROU, DIA A DIA:
${tabela}

TOTAIS DO SISTEMA NO PERÍODO (R$ ${totalSistema.toFixed(2)}):
${Object.entries(porForma).map(([f, v]) => `  ${f}: R$ ${v.toFixed(2)}`).join('\n')}

EXTRATOS COLADOS PELO OPERADOR:
${texto}

Responda SOMENTE com um objeto JSON, sem markdown e sem texto fora dele:
{
  "formas": [{"forma":"","totalExtrato":0,"encontrado":true,"resumo":"","provavelMotivo":""}],
  "porDia": [{"data":"AAAA-MM-DD","sistema":0,"extrato":0,"resumo":""}],
  "naoIdentificado": [{"descricao":"","data":"","valor":0}],
  "resumoGeral": ""
}

Regras:
- Em "formas", use exatamente os nomes que aparecem nos totais do sistema. Não invente.
- "porDia" só precisa trazer os dias em que houve diferença; se tudo bateu, devolva lista vazia.
- Se o extrato traz a data de cada lançamento, use-a para montar "porDia". Se não traz,
  deixe "porDia" vazio e explique isso no "resumoGeral".
- Considere que o dinheiro do cartão costuma cair dias depois da venda, e que taxas
  reduzem o valor creditado. Aponte isso em "provavelMotivo" quando fizer sentido.
- Valores em número, ponto decimal, sem "R$". Textos curtos, em português do Brasil.`;

  let out;
  try {
    out = await pedirJSON(chave, prompt, 6000);
  } catch (e) {
    return res.status(e.status || 502).json({ erro: e.message, bruto: e.bruto });
  }

  out.formas = (out.formas || []).map(f => {
    const sistema = Math.round((porForma[f.forma] || 0) * 100) / 100;
    const extratoV = Math.round((Number(f.totalExtrato) || 0) * 100) / 100;
    const dif = Math.round((extratoV - sistema) * 100) / 100;
    return { ...f, totalSistema: sistema, totalExtrato: extratoV, diferenca: dif,
             bateu: Math.abs(dif) < 0.01 };
  });
  out.totalSistema = Math.round(totalSistema * 100) / 100;
  out.totalExtrato = Math.round(out.formas.reduce((s, f) => s + f.totalExtrato, 0) * 100) / 100;
  out.diferenca = Math.round((out.totalExtrato - out.totalSistema) * 100) / 100;

  return res.status(200).json(out);
}

// ============================================================================
// Chama a IA e devolve JSON. Duas defesas contra resposta fora do formato:
//   1. o turno do assistente já começa com "{", então o modelo continua o JSON
//   2. se ainda vier texto em volta, recortamos do primeiro { ao último }
// ============================================================================
async function pedirJSON(chave, prompt, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': chave,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: maxTokens || 2000,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' },   // obriga a resposta a ser JSON
      ],
    }),
  });

  const dados = await r.json();
  if (!r.ok) {
    const e = new Error((dados && dados.error && dados.error.message) || 'A IA não respondeu.');
    e.status = 502;
    throw e;
  }

  // 1. junta o texto e tira cercas de markdown, se vierem
  let txt = (dados.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  // 2. tenta como veio; depois com a chave do prefill na frente;
  //    por fim, recortando do primeiro { ao último }
  const tentativas = [txt, '{' + txt];
  const ini = txt.indexOf('{');
  const fim = txt.lastIndexOf('}');
  if (ini >= 0 && fim > ini) tentativas.push(txt.slice(ini, fim + 1));

  for (const t of tentativas) {
    try { return JSON.parse(t); } catch (e) {}
  }

  const truncou = dados.stop_reason === 'max_tokens';
  const err = new Error(truncou
    ? 'A resposta da IA foi cortada por ser longa demais. Tente um período menor ou um extrato com menos linhas.'
    : 'A IA respondeu num formato inesperado.');
  err.status = 502;
  err.bruto = txt.slice(0, 500);
  throw err;
}
