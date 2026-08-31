// ============================================================================
// api/whatsapp-enviar.js
// Óticas Idealize — aviso de "óculos pronto" pelo WhatsApp (Z-API)
//
// Este arquivo roda no servidor da Vercel, NÃO no navegador. É por isso que
// ele existe: o token do Z-API nunca chega ao computador do usuário. Se o
// token ficasse no index.html, qualquer pessoa abriria o código-fonte da
// página e passaria a enviar WhatsApp pelo número da loja.
//
// O navegador manda APENAS o id da OS. Quem decide para qual telefone enviar
// e qual texto mandar é este servidor, lendo direto do banco. Assim, mesmo
// que alguém descubra o endereço, não consegue mandar mensagem arbitrária
// para número arbitrário.
// ============================================================================

const {
  ZAPI_INSTANCE,          // id da instância no Z-API
  ZAPI_TOKEN,             // token da instância
  ZAPI_CLIENT_TOKEN,      // token de segurança da conta (header Client-Token)
  SB_URL,                 // https://xxmrdadnchxdsfinvzsp.supabase.co
  SB_SERVICE_KEY,         // service_role do Supabase (NUNCA no HTML)
  LOJA_UNIDADE,           // 'saovicente'
  LOJA_NOME,              // 'São Vicente'
  ORIGENS,                // 'https://saovicente.oticasidealize.online'
} = process.env;

const COLUNAS = ['Pedido', 'Ag. montagem', 'Em montagem', 'Pronto', 'Avisado', 'Entregue'];
const MINUTOS_ENTRE_ENVIOS = 10;   // trava contra clique repetido

function texto(card) {
  const nome = String(card.cliente || '').trim();
  // sem nome cadastrado, a frase se ajusta em vez de deixar buraco
  const emNome = nome ? ` em nome de: ${nome}` : '';
  return 'Olá, tudo bem?\n'
       + `Somos das Óticas Idealize 🕶️ e venho lhe trazer uma ÓTIMA NOTÍCIA, `
       + `seu óculos da Ordem de Serviço nº ${card.os}${emNome} já está pronto! 😉\n`
       + 'Estamos abertos de segunda a sexta das 9h às 19h, '
       + 'e aos sábados e feriados das 9h às 15h.';
}

// (13) 99123-4567 -> 5513991234567
function numero(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (d.length < 10) return null;
  if (d.length <= 11) return '55' + d;
  return d;
}

async function sb(caminho, opcoes = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${caminho}`, {
    ...opcoes,
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

module.exports = async (req, res) => {
  // ── só aceita chamadas vindas do próprio site ────────────────────────────
  const permitidas = (ORIGENS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origem = req.headers.origin || '';
  if (permitidas.length && origem && !permitidas.includes(origem)) {
    return res.status(403).json({ erro: 'Origem não autorizada.' });
  }
  if (origem) res.setHeader('Access-Control-Allow-Origin', origem);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST.' });

  // ── configuração ────────────────────────────────────────────────────────
  const faltando = ['ZAPI_INSTANCE', 'ZAPI_TOKEN', 'SB_URL', 'SB_SERVICE_KEY']
    .filter(k => !process.env[k]);
  if (faltando.length) {
    return res.status(500).json({ erro: 'Faltam variáveis de ambiente: ' + faltando.join(', ') });
  }

  try {
    const corpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = corpo.id;
    if (!id) return res.status(400).json({ erro: 'Informe o id da OS.' });

    // ── busca a OS no banco (é o servidor quem decide os dados) ────────────
    const achados = await sb(`os_cards?id=eq.${encodeURIComponent(id)}&select=*`);
    const card = achados && achados[0];
    if (!card) return res.status(404).json({ erro: 'OS não encontrada.' });

    // ── validações ────────────────────────────────────────────────────────
    if (LOJA_UNIDADE && card.unidade !== LOJA_UNIDADE) {
      return res.status(403).json({ erro: 'Esta OS é de outra unidade.' });
    }
    if (Number(card.col) < 3) {
      return res.status(400).json({
        erro: `A OS ainda está em "${COLUNAS[card.col] || card.col}". O aviso só vale a partir de Pronto.`,
      });
    }
    const fone = numero(card.telefone);
    if (!fone) {
      return res.status(400).json({ erro: 'Esta OS não tem WhatsApp cadastrado.' });
    }

    // ── evita disparo duplicado por clique repetido ────────────────────────
    const historico = Array.isArray(card.history) ? card.history : [];
    const ultimo = historico.filter(h => h && h.whats).map(h => h.at || 0).sort((a, b) => b - a)[0];
    if (ultimo && Date.now() - ultimo < MINUTOS_ENTRE_ENVIOS * 60000) {
      const faltam = Math.ceil((MINUTOS_ENTRE_ENVIOS * 60000 - (Date.now() - ultimo)) / 60000);
      return res.status(429).json({
        erro: `Esta OS já foi avisada há pouco. Tente de novo em ${faltam} min.`,
      });
    }

    // ── envia pelo Z-API ──────────────────────────────────────────────────
    const mensagem = texto(card);
    const envio = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ZAPI_CLIENT_TOKEN ? { 'Client-Token': ZAPI_CLIENT_TOKEN } : {}),
        },
        body: JSON.stringify({ phone: fone, message: mensagem }),
      }
    );
    const resposta = await envio.json().catch(() => ({}));
    if (!envio.ok) {
      return res.status(502).json({
        erro: 'O Z-API recusou o envio.',
        detalhe: resposta.error || resposta.message || `HTTP ${envio.status}`,
      });
    }

    // ── registra no histórico da OS ───────────────────────────────────────
    historico.push({
      u: (corpo.usuario || 'Sistema'),
      r: (corpo.perfil || ''),
      from: card.col, to: card.col, at: Date.now(),
      mc: false, whats: true, auto: true,
      zapId: resposta.messageId || resposta.id || null,
    });
    await sb(`os_cards?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ history: historico }),
    });

    return res.status(200).json({
      ok: true,
      telefone: fone,
      messageId: resposta.messageId || resposta.id || null,
    });
  } catch (e) {
    return res.status(500).json({ erro: 'Falha no envio.', detalhe: String(e.message || e) });
  }
};
