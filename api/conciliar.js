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
const MAX_EXTRATO = 60000;    // caracteres por parte enviada à IA
const MAX_PARTES  = 8;        // o que cabe nos 60s da função (ver vercel.json)
const LIMITE = MAX_PARTES * MAX_EXTRATO;

// Extrato grande não cabe numa chamada só, então vai dividido por linha --
// nunca no meio de uma. Todas as partes são devolvidas: quem decide se cabe
// é quem chama, e a resposta a extrato que não cabe é recusar, não cortar.
function dividirEmBlocos(texto, tamanho) {
  const linhas = String(texto).split(/\r?\n/);
  const blocos = [];
  let atual = '';
  for (const l of linhas) {
    if (atual.length + l.length + 1 > tamanho && atual) {
      blocos.push(atual);
      atual = '';
    }
    atual += (atual ? '\n' : '') + l;
  }
  if (atual) blocos.push(atual);
  return blocos.length ? blocos : [''];
}

const mil = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function medirExtrato(texto) {
  const t = String(texto || '');
  return { caracteres: t.length,
           linhas: t.split(/\r?\n/).filter(l => l.trim()).length };
}

// Extrato que não cabe NÃO é lido pela metade. Meia leitura devolve uma
// diferença que não existe, e isso é pior do que não ter conferido: manda
// a loja caçar um dinheiro que está lá.
function naoCabe(res, partes, medida) {
  if (partes.length <= MAX_PARTES) return false;
  res.status(413).json({
    erro: 'Este extrato é grande demais para uma conferência só.\n\n'
      + 'Recebi ' + mil(medida.linhas) + ' linha(s), '
      + mil(medida.caracteres) + ' caracteres. Cabem '
      + mil(LIMITE) + ' caracteres por vez.\n\n'
      + 'Não vou conferir pela metade: o que ficasse de fora viraria '
      + 'diferença que não existe. Divida o extrato em períodos menores e '
      + 'confira um de cada vez.',
  });
  return true;
}

// As partes vão todas de uma vez. Em fila, a função morria no tempo limite
// antes de terminar de ler -- era o teto real, não os 60.000 caracteres.
async function lerPartes(chave, montar, partes, maxTokens) {
  return Promise.all(partes.map((p, i) => {
    const info = partes.length > 1 ? ` (parte ${i + 1} de ${partes.length})` : '';
    return pedirJSON(chave, montar(p, info), maxTokens);
  }));
}

// Junta o que a IA achou numa forma só, lida em partes. "soNoSistema" é
// recalculado no fim: um lançamento ausente na parte 1 pode estar na 2, e
// somar as listas inventaria lançamento sem par.
function juntarForma(partes, linhas) {
  const out = { totalExtrato: 0, conciliados: [], soNoExtrato: [], soNoSistema: [],
                provavelMotivo: '', resumo: '' };
  partes.forEach(p => {
    out.totalExtrato += Number(p.totalExtrato) || 0;
    (p.conciliados || []).forEach(x => out.conciliados.push(x));
    (p.soNoExtrato || []).forEach(x => out.soNoExtrato.push(x));
    if (p.provavelMotivo && !out.provavelMotivo) out.provavelMotivo = p.provavelMotivo;
    if (p.resumo && !out.resumo) out.resumo = p.resumo;
  });
  const casados = new Set();
  out.conciliados.forEach(c => { if (c && c.os) casados.add(String(c.os)); });
  out.soNoSistema = (linhas || [])
    .filter(l => !casados.has(String(l.os || '')))
    .map(l => ({ os: l.os, valor: Number(l.valor) || 0 }));
  return out;
}

// Junta o resultado de vários blocos: soma os totais por forma e concatena
// as listas. O resumo fica com o do último bloco que trouxe algo.
function juntarResultados(partes) {
  const porForma = {};
  const naoIdent = [];
  const porDia = {};
  let resumo = '';
  partes.forEach(p => {
    (p.formas || []).forEach(f => {
      const k = f.forma;
      if (!porForma[k]) porForma[k] = { forma: k, totalExtrato: 0, encontrado: false,
                                        soNoExtrato: [], soNoSistema: [],
                                        provavelMotivo: '', resumo: '' };
      porForma[k].totalExtrato += Number(f.totalExtrato) || 0;
      if (f.encontrado !== false && (Number(f.totalExtrato) || 0) > 0) porForma[k].encontrado = true;
      if (f.provavelMotivo && !porForma[k].provavelMotivo) porForma[k].provavelMotivo = f.provavelMotivo;
      if (f.resumo && !porForma[k].resumo) porForma[k].resumo = f.resumo;
      (f.soNoExtrato || []).forEach(x => porForma[k].soNoExtrato.push(x));
      // "soNoSistema" de uma parte so nao quer dizer nada: o lancamento pode
      // estar na parte seguinte. Lido em partes, a lista nao e confiavel e
      // fica vazia em vez de apontar lancamento que existe.
      if (partes.length === 1) (f.soNoSistema || []).forEach(x => porForma[k].soNoSistema.push(x));
    });
    (p.naoIdentificado || []).forEach(x => naoIdent.push(x));
    (p.porDia || []).forEach(x => {
      const d = x.data;
      if (!porDia[d]) porDia[d] = { data: d, sistema: 0, extrato: 0, resumo: x.resumo || '' };
      porDia[d].sistema = Number(x.sistema) || porDia[d].sistema;
      porDia[d].extrato += Number(x.extrato) || 0;
    });
    if (p.resumoGeral) resumo = p.resumoGeral;
  });
  return {
    formas: Object.values(porForma),
    naoIdentificado: naoIdent,
    porDia: Object.values(porDia),
    resumoGeral: resumo,
  };
}

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

    const medida = medirExtrato(extrato);
    const partesTexto = dividirEmBlocos(extrato, MAX_EXTRATO);
    if (naoCabe(res, partesTexto, medida)) return;

    const montarPrompt = (texto, parteInfo) =>
`Você confere o caixa de uma ótica. Compare o que o sistema registrou com o extrato.

FORMA DE PAGAMENTO: ${forma}
DATA: ${data || '(não informada)'}

LANÇAMENTOS DO SISTEMA (${linhas.length}, total R$ ${totalSistema.toFixed(2)}):
${linhas.map(l => `- OS ${l.os || '-'} | ${l.cliente || '-'} | R$ ${Number(l.valor || 0).toFixed(2)}`).join('\n') || '(nenhum)'}

EXTRATO COLADO PELO OPERADOR${parteInfo}:
${texto}

IMPORTANTE: sua resposta inteira deve ser UM OBJETO JSON. Comece com { e termine
com }. Nada antes, nada depois, sem crases, sem markdown, sem explicação.
Formato:
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
- No máximo 25 itens em cada lista; havendo mais, diga a quantidade no "resumo".
- Some apenas o que estiver NESTE trecho de extrato.
- Se o extrato não tiver valores reconhecíveis, devolva bateu=false e explique
  em "resumo".`;

    let resultado;
  try {
    const partes = await lerPartes(chave, montarPrompt, partesTexto, 4000);
    resultado = partesTexto.length > 1 ? juntarForma(partes, linhas) : partes[0];
  } catch (e) {
    return res.status(e.status || 502).json({ erro: e.message, bruto: e.bruto });
  }

    // o total do sistema é nosso, não da IA
    resultado.blocos = partesTexto.length;
    resultado.linhasLidas = medida.linhas;
    resultado.caracteres = medida.caracteres;
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

  const medida = medirExtrato(extrato);
  const partesTexto = dividirEmBlocos(extrato, MAX_EXTRATO);
  if (naoCabe(res, partesTexto, medida)) return;

  const blocos = lista.map(f => {
    const linhas = Array.isArray(f.lancamentos) ? f.lancamentos : [];
    const total = linhas.reduce((s, l) => s + (Number(l.valor) || 0), 0);
    return `FORMA: ${f.forma} — total R$ ${total.toFixed(2)} em ${linhas.length} lançamento(s)
${linhas.map(l => `  - OS ${l.os || '-'} | ${l.cliente || '-'} | R$ ${Number(l.valor || 0).toFixed(2)}`).join('\n') || '  (nenhum)'}`;
  }).join('\n\n');

  const montarPrompt = (parteTexto, parteInfo) =>
`Você confere o caixa de uma ótica. Compare o que o sistema registrou, separado por forma
de pagamento, com os extratos que o operador colou. Os extratos vêm misturados: podem ser
de maquininha, Asaas, banco ou vários juntos, cada um marcado com o nome do arquivo.

DATA: ${data || '(não informada)'}

O QUE O SISTEMA REGISTROU:
${blocos}

EXTRATOS COLADOS PELO OPERADOR${parteInfo}:
${parteTexto}

IMPORTANTE: sua resposta inteira deve ser UM OBJETO JSON. Comece com { e termine
com }. Nada antes, nada depois, sem crases, sem markdown, sem explicação.
Formato:
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
- Textos curtos, em português do Brasil.
- No máximo 25 itens em cada lista; havendo mais, diga a quantidade no "resumo".
- Some apenas o que estiver NESTE trecho de extrato.`;

  let out;
  try {
    const partes = await lerPartes(chave, montarPrompt, partesTexto, 6000);
    out = partesTexto.length > 1 ? juntarResultados(partes) : partes[0];
  } catch (e) {
    return res.status(e.status || 502).json({ erro: e.message, bruto: e.bruto });
  }

  // os totais do sistema são nossos, não da IA
  const porNome = {};
  lista.forEach(f => {
    const linhas = Array.isArray(f.lancamentos) ? f.lancamentos : [];
    porNome[f.forma] = linhas.reduce((s, l) => s + (Number(l.valor) || 0), 0);
  });

  const conhecidas = Object.keys(porNome);
  out.formas = (out.formas || []).map(f => {
    const nome = casarForma(f.forma, conhecidas) || f.forma;
    f.forma = nome;                       // devolve sempre o nome que o sistema usa
    const sistema = Math.round((porNome[nome] || 0) * 100) / 100;
    const extratoV = Math.round((Number(f.totalExtrato) || 0) * 100) / 100;
    const dif = Math.round((extratoV - sistema) * 100) / 100;
    return { ...f, totalSistema: sistema, totalExtrato: extratoV, diferenca: dif,
             bateu: Math.abs(dif) < 0.01 };
  });
  out.blocos = partesTexto.length;
  out.linhasLidas = medida.linhas;
  out.caracteres = medida.caracteres;

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

  const medida = medirExtrato(extrato);
  const partesTexto = dividirEmBlocos(extrato, MAX_EXTRATO);
  if (naoCabe(res, partesTexto, medida)) return;

  const porForma = {};
  lista.forEach(d => Object.entries(d.formas || {}).forEach(([f, v]) => {
    porForma[f] = (porForma[f] || 0) + (Number(v) || 0);
  }));
  const totalSistema = Object.values(porForma).reduce((s, v) => s + v, 0);

  const tabela = lista.map(d =>
    `  ${d.data} | caixa R$ ${Number(d.caixa || 0).toFixed(2)} | ` +
    Object.entries(d.formas || {}).map(([f, v]) => `${f} R$ ${Number(v).toFixed(2)}`).join(', ')
  ).join('\n');

  const montarPrompt = (parteTexto, parteInfo) =>
`Você confere o caixa de uma ótica contra os extratos de um período.

PERÍODO: ${periodo || '(não informado)'}

O QUE O SISTEMA REGISTROU, DIA A DIA:
${tabela}

TOTAIS DO SISTEMA NO PERÍODO (R$ ${totalSistema.toFixed(2)}):
${Object.entries(porForma).map(([f, v]) => `  ${f}: R$ ${v.toFixed(2)}`).join('\n')}

EXTRATOS COLADOS PELO OPERADOR${parteInfo}:
${parteTexto}

IMPORTANTE: sua resposta inteira deve ser UM OBJETO JSON. Comece com { e termine
com }. Nada antes, nada depois, sem crases, sem markdown, sem explicação.
Formato:
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
- Valores em número, ponto decimal, sem "R$". Textos curtos, em português do Brasil.
- No máximo 25 itens em cada lista; havendo mais, diga a quantidade no "resumoGeral".
- Some apenas o que estiver NESTE trecho de extrato.`;

  let out;
  try {
    const partes = await lerPartes(chave, montarPrompt, partesTexto, 8000);
    out = partesTexto.length > 1 ? juntarResultados(partes) : partes[0];
  } catch (e) {
    return res.status(e.status || 502).json({ erro: e.message, bruto: e.bruto });
  }

  const conhecidasP = Object.keys(porForma);
  out.formas = (out.formas || []).map(f => {
    const nome = casarForma(f.forma, conhecidasP) || f.forma;
    f.forma = nome;
    const sistema = Math.round((porForma[nome] || 0) * 100) / 100;
    const extratoV = Math.round((Number(f.totalExtrato) || 0) * 100) / 100;
    const dif = Math.round((extratoV - sistema) * 100) / 100;
    return { ...f, totalSistema: sistema, totalExtrato: extratoV, diferenca: dif,
             bateu: Math.abs(dif) < 0.01 };
  });
  out.totalSistema = Math.round(totalSistema * 100) / 100;
  out.totalExtrato = Math.round(out.formas.reduce((s, f) => s + f.totalExtrato, 0) * 100) / 100;
  out.diferenca = Math.round((out.totalExtrato - out.totalSistema) * 100) / 100;
  out.blocos = partesTexto.length;
  out.linhasLidas = medida.linhas;
  out.caracteres = medida.caracteres;

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
      // Este modelo não aceita prefill no turno do assistente, então o JSON
      // é garantido pela instrução no prompt e pelas tentativas de leitura.
      messages: [{ role: 'user', content: prompt }],
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

  // 2. tenta como veio; depois recortando do primeiro { ao último };
  //    por fim, com a chave na frente, caso a resposta comece pelo conteúdo
  const tentativas = [txt];
  const ini = txt.indexOf('{');
  const fim = txt.lastIndexOf('}');
  if (ini >= 0 && fim > ini) tentativas.push(txt.slice(ini, fim + 1));
  tentativas.push('{' + txt);

  for (const t of tentativas) {
    try { return JSON.parse(t); } catch (e) {}
  }

  const truncou = dados.stop_reason === 'max_tokens';
  const err = new Error(truncou
    ? 'A resposta da IA foi cortada por ser longa demais. Isso acontece quando '
      + 'o extrato tem muita linha que não casa com nada. Confira um período '
      + 'menor para ver onde está a sobra.'
    : 'A IA respondeu num formato inesperado.');
  err.status = 502;
  err.bruto = txt.slice(0, 500);
  throw err;
}

// Casa o nome que a IA devolveu com o nome exato que usamos. Sem isto, uma
// resposta com "Credito" em vez de "Crédito" criava uma forma desconhecida,
// o total do sistema vinha zero e a conferência nunca batia.
function casarForma(nome, conhecidas) {
  if (!nome) return null;
  const limpa = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const alvo = limpa(nome);
  return conhecidas.find(c => limpa(c) === alvo)
      || conhecidas.find(c => limpa(c).includes(alvo) || alvo.includes(limpa(c)))
      || null;
}
