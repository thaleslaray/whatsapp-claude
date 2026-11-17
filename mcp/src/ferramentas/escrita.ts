// Ferramentas com cartão (Fase 2): wa_parear, wa_envio, wa_responder e wa_desconectar.
// Nenhuma age antes do clique do dono no cartão. Tudo que dá para recusar é recusado ANTES da prévia (envio
// desligado, grupo não escolhido, conversa desconhecida ou na lista "nunca ler", limite do dia, leitor, sem conexão) e
// conferido de novo no clique (a prévia pode ter ficado 10 minutos no chat).
// 0.7.0: wa_responder também envia para grupo ESCOLHIDO (decisão do dono, 13/11/2026). O cartão mostra, bem à vista,
// quantos participantes recebem: é o dado que evita mandar para o grupo errado.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { dataIso } from "../apresentacao.ts";
import { descricaoCurta, ErroDeBanco, type Banco, type EntradaIndice } from "../banco.ts";
import type { Previa } from "../confirmacao.ts";
import type { Contexto } from "../contexto.ts";
import { ehGrupo, ehIndividual, mascararNumero } from "../jid.ts";
import { marcaDoRascunho } from "../jeito.ts";
import { registrarEscrita, respostaJson } from "../respostas.ts";
import { aprenderComOEnvio, contarDesistencia } from "./jeito.ts";
import type { Citacao } from "../transporte.ts";

export const LIMITE_DO_TEXTO = 4_096;

export const ENVIO_DESLIGADO =
  "O envio de respostas está desligado (ele começa desligado). Nada foi preparado. Para ligar, chame wa_envio: o dono liga com um clique no cartão.";

export const RISCOS_DO_PAREAMENTO = [
  "Este é um cliente NÃO OFICIAL do WhatsApp (aparelho vinculado pela biblioteca Baileys). Usá-lo viola os Termos de Serviço do WhatsApp.",
  "O WhatsApp pode restringir ou banir o número, sem aviso e sem recurso por aqui.",
  "Recomendação: comece por um número secundário, não pelo seu número principal.",
  "Depois de conectado, o Claude lê as suas conversas individuais (menos as da lista \"nunca ler\") e só os grupos que você escolher. Tudo fica cifrado neste computador.",
];

/** Conta caracteres como a pessoa conta (emoji = 1). */
const caracteres = (t: string): number => [...t].length;

function validarTexto(texto: string): string {
  if (texto.trim() === "") throw new Error("O texto da resposta está vazio. Nada foi enviado.");
  if (caracteres(texto) > LIMITE_DO_TEXTO) throw new Error(`O texto tem ${caracteres(texto)} caracteres; o máximo é ${LIMITE_DO_TEXTO}. Nada foi enviado.`);
  return texto;
}

export function alvoDe(banco: Banco, e: EntradaIndice): string {
  if (e.grupo) return `grupo ${banco.idPublico(e.jid)}`;
  return e.numero ? `${mascararNumero(e.numero)} · ${banco.idPublico(e.jid)}` : `conversa ${banco.idPublico(e.jid)}`;
}

/** Quem escreveu uma mensagem de grupo, para a chave dela (citar, reagir): o participante guardado ou o número. */
export function participanteDe(m: { de_mim: boolean; participante?: string; remetente?: { numero?: string } }): string | undefined {
  if (m.de_mim) return undefined;
  return m.participante ?? (m.remetente?.numero ? `${m.remetente.numero}@s.whatsapp.net` : undefined);
}

/** Frase do grupo fora da lista, que ensina a incluir. */
export const GRUPO_NAO_ESCOLHIDO =
  "Esse grupo não está entre os escolhidos: o Claude não lê nem envia para ele. Para incluir, o dono pede e você chama wa_escolher_grupos com `adicionar` (vale com o clique dele no cartão). Nada foi preparado.";

/** Quantos participantes um grupo tem: do cache (1 h) e, se não houver, do WhatsApp. undefined se não deu para saber. */
export async function participantesDoGrupo(ctx: Contexto, banco: Banco, jid: string): Promise<number | undefined> {
  let n = banco.cacheDeGrupos()?.grupos[jid]?.participantes;
  if (n === undefined && ctx.transporte) {
    try {
      n = (await ctx.transporte.buscarGrupos()).grupos[jid]?.participantes;
    } catch {
      /* sem conexão: fica desconhecido */
    }
  }
  return n && n > 0 ? n : undefined;
}

/**
 * A conversa onde escrever: guardada, individual ou grupo escolhido. Grupo conhecido mas fora da lista recusa com a frase
 * que ensina a incluir; "nunca ler" e desconhecida, com as frases do banco.
 * 0.11.0: `grupoEscolhidoVazio` (wa_responder e wa_enviar_arquivo) aceita grupo que o dono ESCOLHEU mesmo sem mensagem
 * guardada ainda; conversa individual continua exigindo conversa existente (número novo é o wa_iniciar_conversa).
 */
export function resolverParaEscrever(banco: Banco, conversa: string, opcoes: { grupoEscolhidoVazio?: boolean } = {}): EntradaIndice {
  let e: EntradaIndice;
  try {
    e = banco.resolver(conversa, opcoes);
  } catch (erro) {
    if (erro instanceof ErroDeBanco && /não está entre os escolhidos/.test(erro.message)) throw new Error(GRUPO_NAO_ESCOLHIDO);
    throw erro;
  }
  if (e.grupo ? !banco.grupoPermitido(e.jid) : !ehIndividual(e.jid)) throw new Error(GRUPO_NAO_ESCOLHIDO);
  return e;
}

interface CorpoResposta {
  jid: string;
  texto: string;
  citar?: Citacao;
}

export function registrarEscritas(server: McpServer, ctx: Contexto): void {
  registrarEscrita(
    server,
    ctx.pedidos,
    "wa_parear",
    { destrutiva: false, idempotente: false },
    {
      title: "Parear o WhatsApp (QR no cartão)",
      description:
        "Mostra o cartão de pareamento: primeiro o aviso de risco (cliente não oficial, pode levar a restrição ou banimento do número) com o botão " +
        '"Entendo o risco, mostrar o QR"; só depois do clique o QR aparece no cartão. Nada conecta antes do clique, e você nunca vê o QR. ' +
        "Na conversa comum o QR aparece no mesmo cartão e se renova sozinho. Na aba Code o clique manda uma mensagem \"Confirmo o pedido <id>, código <codigo>.\": " +
        "chame wa_confirmar com ela, e o resultado desenha um cartão novo com o QR (QR novo: wa_qr, quando o cartão pedir). " +
        "Só funciona sem sessão salva (veja wa_estado). " +
        'Exemplos: "conecta o meu WhatsApp", "quero parear o WhatsApp".',
      inputSchema: z.strictObject({}),
    },
    async (_args, _mcp, escrever) => {
      const { sessao } = await ctx.nucleo();
      if (await sessao.pareada()) throw new Error("O WhatsApp já está pareado neste computador (veja wa_estado). Para trocar de número, use wa_desconectar antes.");
      ctx.exigirDono();
      const previa: Previa = {
        tipo: "parear",
        titulo: "Conectar o WhatsApp a este computador",
        alvo: "este computador",
        riscos: RISCOS_DO_PAREAMENTO,
        detalhes: [
          "Nada se conecta antes do seu clique.",
          "O QR vale 60 s; depois aparece outro (sozinho, ou pelo botão \"Mostrar novo QR\"). O pareamento inteiro tem 5 minutos. Se não terminar, nada fica salvo.",
          "O envio de respostas começa desligado.",
        ],
        botao: "Entendo o risco, mostrar o QR",
      };
      return escrever(
        "wa_parear",
        {},
        previa,
        async () => {
          // Banco que a chave atual não abre (chave do cofre perdida ou arquivo alterado): não serve para nada e travaria as
          // outras ferramentas. Só depois do aceite de risco (este clique) ele é apagado, antes de parear.
          const { banco } = await ctx.nucleo();
          if (!banco.legivel()) banco.apagarTudo();
          await ctx.iniciarPareamento();
          return { pareamento: "iniciado", frase: "Pareamento iniciado: o QR aparece no cartão." };
        },
      );
    },
  );

  registrarEscrita(
    server,
    ctx.pedidos,
    "wa_envio",
    { destrutiva: false, idempotente: true },
    {
      title: "Ligar ou desligar o envio de respostas",
      description:
        "Mostra um cartão para o dono ligar ou desligar o envio de respostas (wa_responder). O envio começa desligado e só muda com o clique no cartão. " +
        "`ligar` diz o que fazer; sem ele, o cartão oferece o contrário do estado atual. " +
        'Exemplos: "liga o envio do WhatsApp", "desliga as respostas pelo Claude".',
      inputSchema: z.strictObject({
        ligar: z.boolean().optional().describe("true para ligar, false para desligar; sem ele, o contrário do estado atual"),
      }),
    },
    async ({ ligar }, _mcp, escrever) => {
      const { banco } = await ctx.nucleo();
      const atual = banco.envioLigado();
      const quer = ligar ?? !atual;
      if (quer === atual) {
        return respostaJson({ envio_ligado: atual, para_o_claude: `O envio já está ${atual ? "ligado" : "desligado"}. Nada mudou; não há cartão.` });
      }
      const limite = ctx.config.limiteDiario;
      const previa: Previa = {
        tipo: "envio",
        titulo: quer ? "Ligar o envio de respostas" : "Desligar o envio de respostas",
        alvo: "este computador",
        detalhes: quer
          ? [
              "Com o envio ligado, o Claude pode preparar respostas (também para os grupos escolhidos e para números novos), edições e exclusões; cada uma ainda precisa do seu clique no cartão dela. Reações saem direto (dá para desfazer).",
              `No máximo ${limite} respostas por dia.`,
              "Aviso: responder por um cliente não oficial aumenta o risco de restrição do número.",
            ]
          : ["Com o envio desligado, o Claude não prepara mais respostas, reações, edições nem exclusões. Ler continua igual."],
        botao: quer ? "Ligar envio" : "Desligar envio",
      };
      return escrever("wa_envio", { ligar: quer }, previa, async (c) => {
        banco.definirEnvio(c.ligar);
        return { envio_ligado: c.ligar, frase: c.ligar ? "Envio ligado: o Claude já pode preparar respostas (cada uma com o seu clique)." : "Envio desligado." };
      });
    },
  );

  registrarEscrita(
    server,
    ctx.pedidos,
    "wa_responder",
    { destrutiva: false, idempotente: false },
    {
      title: "Responder no WhatsApp (com clique)",
      description:
        "Prepara uma resposta numa conversa que já existe (individual ou grupo ESCOLHIDO; id de wa_listar_conversas, nome único ou número) e mostra a prévia num cartão, " +
        "com as últimas mensagens recebidas e o texto, que o dono pode editar. Num grupo, o cartão mostra quantos participantes recebem. Envia SÓ depois do clique dele. " +
        `Texto de até ${LIMITE_DO_TEXTO} caracteres. \`citar\` (opcional) é o id de uma mensagem da conversa (de wa_ler_conversa) para responder citando. ` +
        "Grupo escolhido vale mesmo sem mensagem guardada ainda (id de wa_listar_grupos). " +
        "Recusa grupo fora da lista (wa_escolher_grupos), conversa desconhecida ou da lista \"nunca ler\", envio desligado (veja wa_envio) e o limite do dia. " +
        "Para um número que nunca falou com o dono, use wa_iniciar_conversa. " +
        'Exemplos: "responde à Ana que eu chego às 8", "manda no grupo da família que eu levo o bolo".',
      inputSchema: z.strictObject({
        conversa: z.string().trim().min(1).max(200).describe("id (c_... ou g_...), nome único ou número da conversa"),
        texto: z.string().min(1).max(20_000).describe(`O texto da resposta (até ${LIMITE_DO_TEXTO} caracteres)`),
        citar: z.string().trim().min(1).max(100).optional().describe("id de uma mensagem desta conversa para citar"),
      }),
    },
    async ({ conversa, texto, citar }, _mcp, escrever) => {
      const { banco } = await ctx.nucleo();
      // Tudo recusado ANTES da prévia.
      if (!banco.envioLigado()) throw new Error(ENVIO_DESLIGADO);
      // Desconhecida, "nunca ler" e grupo fora da lista já lançam aqui; grupo escolhido sem mensagem guardada passa.
      const e = resolverParaEscrever(banco, conversa, { grupoEscolhidoVazio: true });
      const t = ctx.exigirDono();
      if (t.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora (veja wa_estado). Nada foi preparado.");
      const limite = ctx.config.limiteDiario;
      const hoje = banco.enviosDoDia(ctx.agora());
      if (hoje >= limite) throw new Error(`O limite de ${limite} respostas por dia foi atingido (${hoje} hoje). Nada foi preparado; o limite volta amanhã.`);
      validarTexto(texto);

      const mensagens = banco.lerMensagens(e.jid);
      let citacao: Citacao | undefined;
      if (citar) {
        const m = mensagens.find((x) => x.id === citar);
        if (!m) throw new Error("Não achei essa mensagem para citar nesta conversa (use o id de wa_ler_conversa). Nada foi preparado.");
        const participante = e.grupo ? participanteDe(m) : undefined;
        if (e.grupo && !m.de_mim && !participante) throw new Error("Não sei quem escreveu essa mensagem do grupo, e a citação precisa disso. Responda sem citar. Nada foi preparado.");
        citacao = { id: m.id, de_mim: m.de_mim, ...(m.texto ? { texto: m.texto } : {}), ...(participante ? { participante } : {}) };
      }
      const participantes = e.grupo ? await participantesDoGrupo(ctx, banco, e.jid) : undefined;
      const nomeDoGrupo = e.grupo ? (e.nome ?? banco.cacheDeGrupos()?.grupos[e.jid]?.nome) : undefined;
      const ultimas = mensagens.filter((m) => !m.de_mim).slice(-3).map((m) => ({ data: dataIso(m.ts), texto: descricaoCurta(m) }));
      const idPublico = banco.idPublico(e.jid);
      const previa: Previa = {
        tipo: "responder",
        titulo: "Responder no WhatsApp",
        alvo: alvoDe(banco, e),
        texto,
        ...(e.grupo
          ? {
              destaque: `ENVIO PARA GRUPO: ${participantes ? `${participantes} participantes vão receber` : "todos os participantes vão receber (não consegui saber quantos)"} esta mensagem.`,
            }
          : {}),
        conteudo_de_terceiros: {
          ...(e.nome ?? nomeDoGrupo ? { nome: (e.nome ?? nomeDoGrupo)! } : {}),
          ...(ultimas.length > 0 ? { ultimas_recebidas: ultimas } : {}),
          ...(citacao ? { citada: citacao.texto ? citacao.texto.slice(0, 500) : "[mensagem sem texto]" } : {}),
        },
        detalhes: [
          `Respostas hoje: ${hoje} de ${limite}.`,
          "Antes de enviar, o WhatsApp mostra “digitando…” por 1 a 3 s. Você não aparece online.",
        ],
        botao: "Enviar",
      };
      const corpo: CorpoResposta = { jid: e.jid, texto, ...(citacao ? { citar: citacao } : {}) };
      return escrever(
        "wa_responder",
        corpo,
        previa,
        async (c) => {
          // Conferido de novo no clique.
          if (!banco.envioLigado()) throw new Error("O envio foi desligado depois da prévia. Nada foi enviado.");
          if (banco.estaBloqueado(c.jid)) throw new Error("Essa conversa entrou na lista \"nunca ler\" depois da prévia. Nada foi enviado.");
          if (ehGrupo(c.jid) && !banco.grupoPermitido(c.jid)) throw new Error("Esse grupo saiu da lista de escolhidos depois da prévia. Nada foi enviado.");
          const tr = ctx.exigirDono();
          if (tr.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi enviado.");
          const contadas = banco.reservarEnvio(ctx.agora(), limite);
          // 0.12.0: o texto proposto (o da prévia, `texto`) contra o que sai (`c.texto`, talvez editado no cartão): a
          // mensagem guardada leva a marca e o par vai para o aprendizado.
          const r = await tr.responder(c.jid, c.texto, c.citar, { rascunho: marcaDoRascunho(texto, c.texto) });
          aprenderComOEnvio(banco, { conversa: c.jid, mensagem_id: r.id, ferramenta: "wa_responder", rascunho: texto, enviado: c.texto, em: r.ts });
          return {
            mensagem_id: r.id,
            conversa: idPublico,
            enviada_em: dataIso(r.ts),
            respostas_hoje: contadas,
            limite_diario: limite,
            frase: `Resposta enviada na conversa ${idPublico}. Respostas hoje: ${contadas} de ${limite}.`,
          };
        },
        { limite: LIMITE_DO_TEXTO, unidade: "caracteres", comTexto: (novo) => ({ ...corpo, texto: validarTexto(novo) }) },
        // O registro de ações fica mesmo depois do wa_desconectar: só o id público, nunca o número (nem mascarado).
        { registro: { conversa: idPublico, alvo: idPublico }, aoDesistir: contarDesistencia(banco) },
      );
    },
  );

  registrarEscrita(
    server,
    ctx.pedidos,
    "wa_desconectar",
    { destrutiva: true, idempotente: false },
    {
      title: "Desconectar o WhatsApp e apagar tudo",
      description:
        "Mostra o cartão para o dono desconectar o WhatsApp deste computador: logout de verdade (o aparelho sai de Aparelhos conectados no celular) e apaga a sessão, " +
        "as mensagens guardadas e as listas (grupos escolhidos e \"nunca ler\"); o envio volta a desligado. A contagem de respostas de hoje continua valendo. Não tem volta; só acontece com o clique. " +
        'Exemplos: "desconecta o WhatsApp", "apaga tudo do WhatsApp deste computador".',
      inputSchema: z.strictObject({}),
    },
    async (_args, _mcp, escrever) => {
      ctx.exigirDono();
      const { banco, sessao } = await ctx.nucleo();
      // Banco ilegível (a chave do cofre se perdeu ou um arquivo foi alterado): a prévia aparece mesmo assim, para haver saída.
      let s: ReturnType<Banco["estatisticas"]> | undefined;
      let ligado = false;
      try {
        s = banco.estatisticas();
        ligado = banco.envioLigado();
      } catch (erro) {
        if (!(erro instanceof ErroDeBanco)) throw erro;
        s = undefined;
      }
      const temDados = s === undefined || s.conversas + s.grupos + s.bloqueadas + s.grupos_permitidos > 0 || ligado;
      if (!sessao.temArquivos() && !temDados) {
        return respostaJson({ para_o_claude: "Não há sessão nem dados guardados neste computador: não há o que desconectar." });
      }
      const conectado = ctx.transporte?.estado().situacao === "conectado";
      const oQue = s ? `${s.conversas} conversa(s) e ${s.grupos} grupo(s) guardados` : "as conversas guardadas";
      const previa: Previa = {
        tipo: "desconectar",
        titulo: "Desconectar o WhatsApp deste computador",
        alvo: "este computador",
        irreversivel: true,
        detalhes: [
          ...(s ? [] : ["Aviso: o banco guardado está ilegível (a chave do cofre deste computador se perdeu (ou um arquivo foi alterado)). Apago tudo o que conseguir."]),
          `Ação sem volta: apaga a sessão, ${oQue}, a lista de grupos escolhidos e a lista "nunca ler". O envio volta a desligado; a contagem de respostas de hoje continua valendo.`,
          conectado ? "O aparelho sai da lista de Aparelhos conectados do celular." : "Aviso: o WhatsApp não está conectado agora; apago tudo aqui, e o aparelho pode continuar em Aparelhos conectados no celular (tire por lá).",
          "Para usar de novo, será preciso parear (QR) outra vez.",
          "Aviso: os arquivos abertos com wa_abrir_midia em Downloads/WhatsApp Claude (sem cifra) não são apagados; apague-os você, se quiser.",
          "O modelo de transcrição (arquivo público, sem cifra, na subpasta modelos da pasta de dados) não é apagado; as transcrições guardadas com as mensagens são.",
        ],
        botao: "Desconectar e apagar",
      };
      return escrever("wa_desconectar", {}, previa, async () => {
        const r = await ctx.exigirDono().desconectar();
        return {
          desconectado: true,
          logout_no_whatsapp: r.logout_no_whatsapp,
          frase: r.logout_no_whatsapp
            ? "Desconectado: o aparelho saiu do WhatsApp e tudo foi apagado deste computador."
            : "Tudo foi apagado deste computador. O WhatsApp não confirmou o logout: confira em Aparelhos conectados no celular.",
        };
      });
    },
  );
}
