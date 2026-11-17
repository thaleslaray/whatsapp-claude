// 0.7.0, parte 1: escritas novas e histórico (decisão do dono, 13/11/2026).
// - wa_iniciar_conversa (cartão): conversa com número que nunca falou com o dono. Confere no WhatsApp antes da prévia;
//   o cartão mostra o número INTEIRO (só no `_meta`); teto próprio por dia (WA_LIMITE_NOVAS_CONVERSAS), além do geral.
// - wa_reagir (direta, reversível, como as ações reversíveis do MCP do Instagram): executa na hora e fica no registro;
//   teto por dia igual ao limite diário, para uma injeção não disparar reações sem fim.
// - wa_editar (cartão com o antes e o depois, texto novo editável): só texto meu, até 15 min, conferido de novo no clique.
// - wa_apagar (cartão, sem volta): só mensagem minha, "apagar para todos", até 48 h.
// - wa_buscar_historico (leitura, sem cartão, com freio): pede ao celular mensagens anteriores à mais antiga guardada.
//   0.13.0: com `ate_total`, repete o pedido em segundo plano (historico-em-lote.ts) até a conversa ter tantas guardadas.
//   0.13.1: grupo escolhido sem mensagem guardada parte de uma âncora sintética (experimento; historico-em-lote.ts).
// Regra comum das escritas: envio ligado, dono da conexão (o leitor repassa pelo canal), registro de ações, recusa
// "nunca ler" e grupo não escolhido. Texto de terceiros na prévia passa pela mesma limpeza de sempre (escrita.ts).

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { dataIso } from "../apresentacao.ts";
import { descricaoCurta, type Banco, type EntradaIndice, type MensagemGuardada } from "../banco.ts";
import { INTERVALO_DO_HISTORICO_MS } from "../config.ts";
import type { Previa } from "../confirmacao.ts";
import type { Contexto } from "../contexto.ts";
import { ehGrupo, numeroDe } from "../jid.ts";
import { marcaDoRascunho } from "../jeito.ts";
import { registrarEscrita, registrarEscritaDireta, respostaJson } from "../respostas.ts";
import { aprenderComOEnvio, contarDesistencia } from "./jeito.ts";
import { VARIACOES_DO_HISTORICO } from "../transporte.ts";
import {
  ANCORAS_SINTETICAS,
  ancoraSintetica,
  FRASE_DA_PARADA,
  grupoEscolhidoVazio,
  MAXIMO_DO_ATE_TOTAL,
  resultadoDoCelular,
  TRABALHOS_EM_PARALELO,
  type AncoraSintetica,
} from "../historico-em-lote.ts";
import { alvoDe, ENVIO_DESLIGADO, LIMITE_DO_TEXTO, participanteDe, resolverParaEscrever } from "./escrita.ts";

/** O WhatsApp só aceita editar por 15 minutos. */
export const JANELA_DA_EDICAO_MS = 15 * 60_000;
/** Apagar para todos: aqui, até 48 h. */
export const JANELA_DA_EXCLUSAO_MS = 48 * 3_600_000;
export const MAXIMO_DO_HISTORICO = 50;

/** 0.13.1: a frase da conversa individual sem mensagem guardada (âncora sintética só vale para grupo escolhido). */
export const SEM_PARTIDA_INDIVIDUAL =
  "Não há mensagem guardada nesta conversa individual para servir de ponto de partida, e pedir histórico sem ponto de partida só é tentado em grupo escolhido. Quando chegar (ou o dono mandar) uma mensagem nela, peça de novo.";

/** 0.13.1: a ordem das âncoras sintéticas desta conversa: a forçada, ou o rodízio do modo auto a partir da próxima. */
function ordemDasSinteticas(ctx: Contexto, jid: string, forcada: AncoraSintetica | "auto"): AncoraSintetica[] {
  if (forcada !== "auto") return [forcada];
  const i = ctx.ancoraSinteticaAuto.get(jid) ?? 0;
  return ANCORAS_SINTETICAS.map((_, k) => ANCORAS_SINTETICAS[(i + k) % ANCORAS_SINTETICAS.length]!);
}

/** 0.13.1: depois de um pedido sem partida: o rodízio passa à próxima (se não veio nada) e a caixa-preta anota, sem conteúdo. */
function anotarSemPartida(ctx: Contexto, jid: string, ancora: AncoraSintetica, r: { chegou: boolean; recebidas: number; novas: number; diagnostico: { pedido_enviado: boolean } }): void {
  if (r.novas === 0) ctx.ancoraSinteticaAuto.set(jid, (ANCORAS_SINTETICAS.indexOf(ancora) + 1) % ANCORAS_SINTETICAS.length);
  else ctx.ancoraSinteticaAuto.delete(jid);
  ctx.caixaPreta.registrar("historico_sem_partida", { ancora, resultado: resultadoDoCelular(r), recebidas: r.recebidas, novas: r.novas });
}

const caracteres = (t: string): number => [...t].length;

function validarTexto(texto: string): string {
  if (texto.trim() === "") throw new Error("O texto está vazio. Nada foi enviado.");
  if (caracteres(texto) > LIMITE_DO_TEXTO) throw new Error(`O texto tem ${caracteres(texto)} caracteres; o máximo é ${LIMITE_DO_TEXTO}. Nada foi enviado.`);
  return texto;
}

/** Envio ligado e WhatsApp conectado neste processo (dono). Devolve o transporte. */
function exigirEnvioConectado(ctx: Contexto, banco: Banco, nada = "Nada foi preparado.") {
  if (!banco.envioLigado()) throw new Error(ENVIO_DESLIGADO);
  const t = ctx.exigirDono();
  if (t.estado().situacao !== "conectado") throw new Error(`O WhatsApp não está conectado agora (veja wa_estado). ${nada}`);
  return t;
}

function mensagemDa(banco: Banco, e: EntradaIndice, id: string): MensagemGuardada {
  const m = banco.lerMensagens(e.jid).find((x) => x.id === id);
  if (!m) throw new Error("Não achei essa mensagem nesta conversa (use o id de wa_ler_conversa).");
  return m;
}

/** Um emoji só (um grafema com pictograma), ou vazio. */
export function emojiValido(emoji: string): boolean {
  if (emoji === "") return true;
  const grafemas = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji)];
  return grafemas.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji);
}

/** Dígitos de um número digitado, com DDI. undefined se não parece telefone. */
export function digitosDoTelefone(texto: string): string | undefined {
  const t = texto.trim();
  if (!/^\+?[\d\s().-]+$/.test(t)) return undefined;
  const d = t.replace(/\D/g, "");
  return /^[1-9]\d{9,14}$/.test(d) ? d : undefined;
}

const TELEFONE_INVALIDO = "Isso não parece um número de telefone com DDI (ex.: +55 11 91234-5678). Nada foi preparado.";

interface CorpoNovaConversa {
  jid: string;
  texto: string;
}
interface CorpoEdicao {
  jid: string;
  id: string;
  texto: string;
}
interface CorpoExclusao {
  jid: string;
  id: string;
}

export function registrarMaisEscritas(server: McpServer, ctx: Contexto): void {
  registrarEscrita(
    server,
    ctx.pedidos,
    "wa_iniciar_conversa",
    { destrutiva: false, idempotente: false },
    {
      title: "Começar conversa com número novo (com clique)",
      description:
        "Prepara a PRIMEIRA mensagem para um número que ainda não tem conversa com o dono (número com DDI, ex.: +55 11 91234-5678) e mostra a prévia num cartão, " +
        "com o número inteiro para o dono conferir e o texto, que ele pode editar. Confere antes no WhatsApp se o número tem conta. Envia SÓ depois do clique. " +
        "Teto baixo por dia (campo \"Conversas novas por dia\"; 0 desliga): começar conversa com desconhecido é o que mais leva o WhatsApp a banir. " +
        "Recusa número que já tem conversa (use wa_responder), da lista \"nunca ler\", sem WhatsApp, envio desligado e os limites do dia. " +
        'Exemplos: "manda um oi para +55 11 91234-5678", "começa uma conversa com o número do encanador".',
      inputSchema: z.strictObject({
        numero: z.string().trim().min(1).max(40).describe("O número com DDI (ex.: +55 11 91234-5678)"),
        texto: z.string().min(1).max(20_000).describe(`A primeira mensagem (até ${LIMITE_DO_TEXTO} caracteres)`),
      }),
    },
    async ({ numero, texto }, _chamada, escrever) => {
      const { banco } = await ctx.nucleo();
      const limiteNovas = ctx.config.limiteNovasConversas;
      if (limiteNovas <= 0) throw new Error("Começar conversa com número novo está desligado (o campo \"Conversas novas por dia\" da extensão está em 0). Nada foi preparado.");
      if (!banco.envioLigado()) throw new Error(ENVIO_DESLIGADO);
      const digitos = digitosDoTelefone(numero);
      if (!digitos) throw new Error(TELEFONE_INVALIDO);
      validarTexto(texto);
      const recusarExistente = (jid: string) => {
        if (banco.estaBloqueado(jid)) throw new Error("Esse número está na lista \"nunca ler\". Nada foi preparado.");
        if (banco.entrada(banco.chaveDaConversa(jid))) throw new Error(`Já existe conversa com esse número: use wa_responder (conversa ${banco.idPublico(banco.chaveDaConversa(jid))}). Nada foi preparado.`);
      };
      const pedido = `${digitos}@s.whatsapp.net`;
      recusarExistente(pedido);
      const t = exigirEnvioConectado(ctx, banco);
      const limite = ctx.config.limiteDiario;
      const agora = ctx.agora();
      const hoje = banco.enviosDoDia(agora);
      const novasHoje = banco.contagemDoDia("novas", agora);
      if (novasHoje >= limiteNovas) throw new Error(`O limite de ${limiteNovas} conversas novas por dia foi atingido (${novasHoje} hoje). Nada foi preparado; o limite volta amanhã.`);
      if (hoje >= limite) throw new Error(`O limite de ${limite} respostas por dia foi atingido (${hoje} hoje). Nada foi preparado; o limite volta amanhã.`);
      const jid = await t.noWhatsApp(pedido);
      if (!jid) throw new Error("Esse número não tem WhatsApp. Nada foi preparado.");
      if (jid !== pedido) recusarExistente(jid);
      const final = numeroDe(jid)!;
      const idPublico = banco.idPublico(jid);
      const previa: Previa = {
        tipo: "iniciar",
        titulo: "Começar conversa com um número novo",
        alvo: `+${final} (número novo)`,
        destaque: `CONVERSA NOVA com +${final}: este número ainda não tem conversa com você. Confira o número inteiro antes de enviar.${final !== digitos ? ` (O WhatsApp corrigiu o número digitado, +${digitos}.)` : ""}`,
        texto,
        detalhes: [
          "Aviso: começar conversa com quem não tem o seu número é o comportamento que mais leva o WhatsApp a restringir ou banir a conta.",
          `Conversas novas hoje: ${novasHoje} de ${limiteNovas}. Respostas hoje: ${hoje} de ${limite}.`,
          "Antes de enviar, o WhatsApp mostra “digitando…” por 1 a 3 s. Você não aparece online.",
        ],
        botao: "Enviar",
      };
      const corpo: CorpoNovaConversa = { jid, texto };
      return escrever(
        "wa_iniciar_conversa",
        corpo,
        previa,
        async (c) => {
          if (!banco.envioLigado()) throw new Error("O envio foi desligado depois da prévia. Nada foi enviado.");
          if (banco.estaBloqueado(c.jid)) throw new Error("Esse número entrou na lista \"nunca ler\" depois da prévia. Nada foi enviado.");
          const tr = ctx.exigirDono();
          if (tr.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi enviado.");
          const n = banco.reservarContagens(ctx.agora(), [
            { tipo: "novas", limite: ctx.config.limiteNovasConversas, frase: `O limite de ${ctx.config.limiteNovasConversas} conversas novas por dia foi atingido. Nada foi enviado; o limite volta amanhã.` },
            { tipo: "envios", limite: ctx.config.limiteDiario, frase: `O limite de ${ctx.config.limiteDiario} respostas por dia foi atingido. Nada foi enviado; o limite volta amanhã.` },
          ]);
          // 0.12.0: proposto contra enviado, como no wa_responder.
          const r = await tr.responder(c.jid, c.texto, undefined, { rascunho: marcaDoRascunho(texto, c.texto) });
          aprenderComOEnvio(banco, { conversa: c.jid, mensagem_id: r.id, ferramenta: "wa_iniciar_conversa", rascunho: texto, enviado: c.texto, em: r.ts });
          return {
            mensagem_id: r.id,
            conversa: idPublico,
            enviada_em: dataIso(r.ts),
            conversas_novas_hoje: n.novas,
            respostas_hoje: n.envios,
            frase: `Conversa nova começada (${idPublico}). Conversas novas hoje: ${n.novas} de ${ctx.config.limiteNovasConversas}.`,
          };
        },
        { limite: LIMITE_DO_TEXTO, unidade: "caracteres", comTexto: (novo) => ({ ...corpo, texto: validarTexto(novo) }) },
        // O número inteiro fica só no cartão: o modelo e o registro de ações veem o id público.
        { registro: { conversa: idPublico, alvo: idPublico }, alvoParaOClaude: `conversa nova ${idPublico}`, aoDesistir: contarDesistencia(banco) },
      );
    },
  );

  registrarEscritaDireta(
    server,
    "wa_reagir",
    { destrutiva: false, idempotente: true },
    {
      title: "Reagir a uma mensagem",
      description:
        "Reage a uma mensagem com UM emoji (vazio tira a reação), numa conversa individual ou num grupo escolhido. Age na hora, sem cartão, porque dá para desfazer; fica no registro de ações. " +
        "`mensagem` é o id de wa_ler_conversa. Exige o envio ligado; há um teto de reações por dia. " +
        'Exemplos: "reage com 👍 à última mensagem da Ana", "tira a minha reação".',
      inputSchema: z.strictObject({
        conversa: z.string().trim().min(1).max(200).describe("id (c_... ou g_...), nome único ou número da conversa"),
        mensagem: z.string().trim().min(1).max(100).describe("id da mensagem (de wa_ler_conversa)"),
        emoji: z.string().max(40).describe("Um emoji só; vazio tira a reação"),
      }),
    },
    async ({ conversa, mensagem, emoji }) => {
      const { banco } = await ctx.nucleo();
      if (!emojiValido(emoji)) throw new Error("A reação aceita um emoji só (ou vazio, para tirar a reação). Nada foi feito.");
      if (!banco.envioLigado()) throw new Error(ENVIO_DESLIGADO);
      const e = resolverParaEscrever(banco, conversa);
      const m = mensagemDa(banco, e, mensagem);
      const t = exigirEnvioConectado(ctx, banco, "Nada foi feito.");
      const participante = e.grupo ? participanteDe(m) : undefined;
      if (e.grupo && !m.de_mim && !participante) throw new Error("Não sei quem escreveu essa mensagem do grupo, e a reação precisa disso. Nada foi feito.");
      const limite = ctx.config.limiteDiario;
      const n = banco.reservarContagens(ctx.agora(), [
        { tipo: "reacoes", limite, frase: `O limite de ${limite} reações por dia foi atingido. Nada foi feito; o limite volta amanhã.` },
      ]);
      const idPublico = banco.idPublico(e.jid);
      await t.reagir(e.jid, { id: m.id, de_mim: m.de_mim, ...(participante ? { participante } : {}) }, emoji);
      // Registro sem o emoji nem o texto: só onde, em que mensagem e se tirou.
      ctx.registro.gravar({ evento: "reacao", ferramenta: "wa_reagir", conversa: idPublico, mensagem: m.id, ...(emoji === "" ? { tirou: true } : {}) });
      return respostaJson({
        conversa: idPublico,
        mensagem: m.id,
        reacao: emoji === "" ? "tirada" : "feita",
        reacoes_hoje: n.reacoes,
        limite_diario_de_reacoes: limite,
        para_o_claude: emoji === "" ? "Reação tirada." : "Reação feita. Para desfazer, chame wa_reagir com emoji vazio.",
      });
    },
  );

  registrarEscrita(
    server,
    ctx.pedidos,
    "wa_editar",
    { destrutiva: false, idempotente: false },
    {
      title: "Editar uma mensagem sua (com clique)",
      description:
        "Prepara a edição de uma mensagem de TEXTO que o dono enviou (id de wa_ler_conversa, de_mim) e mostra no cartão o texto de agora e o novo, que o dono pode ajustar. " +
        "Só vale até 15 minutos depois do envio (regra do WhatsApp); edita SÓ depois do clique. " +
        'Exemplos: "corrige a minha última mensagem para a Ana: era 9h, não 8h".',
      inputSchema: z.strictObject({
        conversa: z.string().trim().min(1).max(200).describe("id (c_... ou g_...), nome único ou número da conversa"),
        mensagem: z.string().trim().min(1).max(100).describe("id da mensagem sua (de wa_ler_conversa)"),
        texto: z.string().min(1).max(20_000).describe(`O texto novo (até ${LIMITE_DO_TEXTO} caracteres)`),
      }),
    },
    async ({ conversa, mensagem, texto }, _chamada, escrever) => {
      const { banco } = await ctx.nucleo();
      if (!banco.envioLigado()) throw new Error(ENVIO_DESLIGADO);
      const e = resolverParaEscrever(banco, conversa);
      const m = mensagemDa(banco, e, mensagem);
      if (!m.de_mim) throw new Error("Só dá para editar mensagem sua (de_mim). Nada foi preparado.");
      if (m.tipo !== "texto" || !m.texto) throw new Error("Só dá para editar mensagem de texto. Nada foi preparado.");
      if (ctx.agora() - m.ts > JANELA_DA_EDICAO_MS) throw new Error("O WhatsApp só deixa editar até 15 minutos depois do envio, e essa mensagem é mais velha. Nada foi preparado.");
      validarTexto(texto);
      if (texto === m.texto) throw new Error("O texto novo é igual ao de agora. Nada foi preparado.");
      exigirEnvioConectado(ctx, banco);
      const idPublico = banco.idPublico(e.jid);
      const previa: Previa = {
        tipo: "editar",
        titulo: "Editar mensagem no WhatsApp",
        alvo: alvoDe(banco, e),
        mensagem_atual: { texto: m.texto, data: dataIso(m.ts) },
        texto,
        ...(e.nome ? { conteudo_de_terceiros: { nome: e.nome } } : {}),
        detalhes: [
          "Quem recebeu vê a mensagem trocada, com a marca “editada”.",
          `O WhatsApp só aceita até 15 minutos depois do envio (até ${new Date(m.ts + JANELA_DA_EDICAO_MS).toISOString().slice(11, 16)} UTC).`,
        ],
        botao: "Editar",
      };
      const corpo: CorpoEdicao = { jid: e.jid, id: m.id, texto };
      return escrever(
        "wa_editar",
        corpo,
        previa,
        async (c) => {
          if (!banco.envioLigado()) throw new Error("O envio foi desligado depois da prévia. Nada foi editado.");
          if (banco.estaBloqueado(c.jid) || (ehGrupo(c.jid) && !banco.grupoPermitido(c.jid))) throw new Error("Essa conversa saiu do que o Claude pode ler depois da prévia. Nada foi editado.");
          const atual = banco.lerMensagens(c.jid).find((x) => x.id === c.id);
          if (!atual || !atual.de_mim) throw new Error("A mensagem não está mais guardada. Nada foi editado.");
          if (ctx.agora() - atual.ts > JANELA_DA_EDICAO_MS) throw new Error("Passaram os 15 minutos em que o WhatsApp deixa editar. Nada foi editado.");
          const tr = ctx.exigirDono();
          if (tr.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi editado.");
          await tr.editar(c.jid, c.id, c.texto);
          return { conversa: idPublico, mensagem: c.id, editada: true, frase: `Mensagem editada na conversa ${idPublico}.` };
        },
        { limite: LIMITE_DO_TEXTO, unidade: "caracteres", comTexto: (novo) => ({ ...corpo, texto: validarTexto(novo) }) },
        { registro: { conversa: idPublico, alvo: idPublico, mensagem: m.id } },
      );
    },
  );

  registrarEscrita(
    server,
    ctx.pedidos,
    "wa_apagar",
    { destrutiva: true, idempotente: false },
    {
      title: "Apagar uma mensagem sua para todos (com clique)",
      description:
        "Prepara \"apagar para todos\" de uma mensagem que o DONO enviou (id de wa_ler_conversa, de_mim) e mostra no cartão a mensagem que vai sumir. " +
        "Só mensagens de até 48 h. Não tem volta; apaga SÓ depois do clique. " +
        'Exemplos: "apaga a mensagem que eu mandei errado no grupo".',
      inputSchema: z.strictObject({
        conversa: z.string().trim().min(1).max(200).describe("id (c_... ou g_...), nome único ou número da conversa"),
        mensagem: z.string().trim().min(1).max(100).describe("id da mensagem sua (de wa_ler_conversa)"),
      }),
    },
    async ({ conversa, mensagem }, _chamada, escrever) => {
      const { banco } = await ctx.nucleo();
      if (!banco.envioLigado()) throw new Error(ENVIO_DESLIGADO);
      const e = resolverParaEscrever(banco, conversa);
      const m = mensagemDa(banco, e, mensagem);
      if (!m.de_mim) throw new Error("Só dá para apagar mensagem sua (de_mim). Nada foi preparado.");
      if (ctx.agora() - m.ts > JANELA_DA_EXCLUSAO_MS) throw new Error("Só dá para apagar para todos mensagens de até 48 h, e essa é mais velha. Nada foi preparado.");
      exigirEnvioConectado(ctx, banco);
      const idPublico = banco.idPublico(e.jid);
      const previa: Previa = {
        tipo: "apagar",
        titulo: "Apagar mensagem para todos",
        alvo: alvoDe(banco, e),
        irreversivel: true,
        mensagem_atual: { texto: descricaoCurta(m) || `[${m.tipo}]`, data: dataIso(m.ts) },
        ...(e.nome ? { conteudo_de_terceiros: { nome: e.nome } } : {}),
        detalhes: ["Ação sem volta: a mensagem some para todos; no lugar fica “Mensagem apagada”."],
        botao: "Apagar para todos",
      };
      const corpo: CorpoExclusao = { jid: e.jid, id: m.id };
      return escrever(
        "wa_apagar",
        corpo,
        previa,
        async (c) => {
          if (!banco.envioLigado()) throw new Error("O envio foi desligado depois da prévia. Nada foi apagado.");
          if (banco.estaBloqueado(c.jid) || (ehGrupo(c.jid) && !banco.grupoPermitido(c.jid))) throw new Error("Essa conversa saiu do que o Claude pode ler depois da prévia. Nada foi apagado.");
          const atual = banco.lerMensagens(c.jid).find((x) => x.id === c.id);
          if (atual && ctx.agora() - atual.ts > JANELA_DA_EXCLUSAO_MS) throw new Error("Passaram as 48 h. Nada foi apagado.");
          const tr = ctx.exigirDono();
          if (tr.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi apagado.");
          await tr.apagar(c.jid, c.id);
          return { conversa: idPublico, mensagem: c.id, apagada: true, frase: `Mensagem apagada para todos na conversa ${idPublico}.` };
        },
        undefined,
        { registro: { conversa: idPublico, alvo: idPublico, mensagem: m.id } },
      );
    },
  );

  // Não manda nada a ninguém e não precisa do envio ligado (é leitura), mas grava no banco e fala com o celular: fica
  // fora das cinco leituras que um leitor sem canal responde sozinho.
  registrarEscritaDireta(
    server,
    "wa_buscar_historico",
    { destrutiva: false, idempotente: false },
    {
      title: "Buscar mensagens mais antigas no celular",
      description:
        "Pede ao celular do dono até `quantidade` (máx. 50) mensagens ANTERIORES à mais antiga guardada de uma conversa (individual ou grupo escolhido) e guarda o que chegar, " +
        "pelos mesmos filtros (\"nunca ler\", grupos escolhidos). Espera a resposta por uns 20 s. Conversa individual precisa de pelo menos uma mensagem guardada. " +
        "Grupo escolhido SEM mensagem guardada (experimento): o pedido parte de uma âncora sintética (`agora_de_mim`, `agora_de_outro` ou `sem_id`, uma por pedido, em rodízio no modo auto; `ancora` força uma); a resposta diz qual foi usada e o que o celular fez (`resultado_do_celular`: com_mensagens, vazio, silencio). Depois da primeira mensagem guardada, a âncora é a real. " +
        "Freio: um pedido por conversa a cada 30 s e um limite de pedidos por dia (campo \"Pedidos de histórico por dia\" da extensão; padrão 30). Depois, leia com wa_ler_conversa. " +
        `Com \`ate_total\` (até ${MAXIMO_DO_ATE_TOTAL}): repete o pedido em SEGUNDO PLANO, respeitando os 30 s, até a conversa ter \`ate_total\` mensagens guardadas, o celular parar de responder, não vir mais nada antigo ou acabar o limite do dia; a chamada volta na hora com "em andamento", e chamar de novo com os mesmos argumentos devolve o progresso (pedidos feitos, mensagens novas, por que parou). ` +
        `Um por conversa, no máximo ${TRABALHOS_EM_PARALELO} conversas ao mesmo tempo; para no desconectar, ao bloquear a conversa ou tirar o grupo. Use para aprender com um grupo, só quando o dono pedir. ` +
        "O pedido de histórico é experimental e pode não ser atendido pelo WhatsApp: a resposta traz `diagnostico` (sem conteúdo). No modo `auto`, conversa individual com LID conhecido começa pela variação `lid` (a única que o celular atendeu no WhatsApp real); as outras começam em `padrao`; cada tentativa sem resposta passa à próxima variação do pedido. " +
        'Exemplos: "busca mensagens mais antigas da conversa com a Ana", "puxa o histórico do grupo de alunos, até umas 1.000 mensagens".',
      inputSchema: z.strictObject({
        conversa: z.string().trim().min(1).max(200).describe("id (c_... ou g_...), nome único ou número da conversa"),
        quantidade: z.number().int().min(1).max(MAXIMO_DO_HISTORICO).default(MAXIMO_DO_HISTORICO).describe("Quantas mensagens pedir (1 a 50); com `ate_total`, por pedido"),
        variacao: z
          .enum(["auto", ...VARIACOES_DO_HISTORICO])
          .default("auto")
          .describe("Como montar o pedido (diagnóstico). Deixe em auto, a não ser que o dono peça uma: padrao, lid, pn_com_conta ou segundos"),
        ate_total: z
          .number()
          .int()
          .min(1)
          .max(MAXIMO_DO_ATE_TOTAL)
          .optional()
          .describe(`Repete em segundo plano até a conversa ter tantas mensagens guardadas (até ${MAXIMO_DO_ATE_TOTAL}); chame de novo com os mesmos argumentos para ver o progresso`),
        ancora: z
          .enum(["auto", ...ANCORAS_SINTETICAS])
          .default("auto")
          .describe("Só para grupo escolhido sem mensagem guardada (experimento): a âncora sintética do pedido. Deixe em auto (rodízio), a não ser que o dono peça: agora_de_mim, agora_de_outro ou sem_id"),
      }),
    },
    async ({ conversa, quantidade, variacao: pedida, ate_total, ancora: ancoraPedida }) => {
      const { banco } = await ctx.nucleo();
      // 0.13.1: grupo escolhido sem mensagem guardada passa (como no wa_responder); individual sem mensagem, não.
      let e: EntradaIndice;
      try {
        e = resolverParaEscrever(banco, conversa, { grupoEscolhidoVazio: true });
      } catch (erro) {
        // Conversa individual sem nada guardado: a frase diz por que não há pedido sem ponto de partida.
        if (erro instanceof Error && /Não há mensagens guardadas dessa conversa/.test(erro.message)) throw new Error(SEM_PARTIDA_INDIVIDUAL);
        throw erro;
      }
      const limiteDoDia = ctx.config.pedidosDeHistoricoPorDia;
      if (ate_total !== undefined) return historicoEmSegundoPlano(ctx, banco, e, ate_total, quantidade, pedida, limiteDoDia, ancoraPedida);
      if (ctx.historicoEmLote.andandoEm(e.jid)) {
        throw new Error("Esta conversa já está buscando histórico em segundo plano (`ate_total`): chame com o mesmo `ate_total` para ver o progresso, em vez de um pedido avulso.");
      }
      const ancora = banco.lerMensagens(e.jid)[0];
      const vazio = !ancora && grupoEscolhidoVazio(banco, e.jid);
      if (!ancora && !vazio) throw new Error(SEM_PARTIDA_INDIVIDUAL);
      const t = ctx.exigirDono();
      if (t.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora (veja wa_estado).");
      const agora = Date.now();
      const ultimo = ctx.ultimoHistorico.get(e.jid);
      if (ultimo !== undefined && agora - ultimo < INTERVALO_DO_HISTORICO_MS) {
        throw new Error(`Já pedi histórico desta conversa há pouco: espere 30 s entre um pedido e outro (faltam ${Math.ceil((INTERVALO_DO_HISTORICO_MS - (agora - ultimo)) / 1000)} s).`);
      }
      // 0.7.2: a variação é decidida antes de contar o pedido: a que não se aplica recusa sem gastar a contagem nem o freio.
      const variacao = await t.variacaoDoHistorico(e.jid, pedida);
      const n = banco.reservarContagens(ctx.agora(), [
        { tipo: "historico", limite: limiteDoDia, frase: `O limite de ${limiteDoDia} pedidos de histórico por dia foi atingido. O limite volta amanhã.` },
      ]);
      ctx.ultimoHistorico.set(e.jid, agora);
      const sintetica = ancora ? undefined : ordemDasSinteticas(ctx, e.jid, ancoraPedida)[0]!;
      const participante = ancora && e.grupo ? participanteDe(ancora) : undefined;
      const chave = ancora ? { id: ancora.id, de_mim: ancora.de_mim, ts: ancora.ts, ...(participante ? { participante } : {}) } : ancoraSintetica(sintetica!, Date.now());
      const r = await t.buscarHistorico(e.jid, quantidade, chave, ctx.esperaDoHistoricoMs, variacao);
      if (sintetica) anotarSemPartida(ctx, e.jid, sintetica, r);
      const idPublico = banco.idPublico(e.jid);
      // 0.13.1: o diagnóstico diz a âncora (real ou a sintética) e o que o celular fez.
      const d = { ...r.diagnostico, ancora: sintetica ?? "real", resultado_do_celular: resultadoDoCelular(r) };
      ctx.registro.gravar({
        evento: "historico_pedido",
        ferramenta: "wa_buscar_historico",
        conversa: idPublico,
        quantidade,
        chegou: r.chegou,
        novas: r.novas,
        cortadas: r.cortadas,
        variacao,
        ancora: d.ancora,
        ack: d.ack_do_servidor,
        recibo: d.recibo_do_celular,
      });
      const segundos = Math.round(d.espera_ms / 1000);
      const proxima = pedida === "auto" ? "no modo auto, a próxima tentativa usa outra variação." : 'com variacao "auto", a próxima tentativa usa outra variação.';
      const a = r.resposta_atrasada_do_pedido_anterior;
      const anterior = a ? `A resposta do pedido anterior chegou depois do tempo (${a.segundos_apos_o_pedido} s, variação ${a.variacao}) e trouxe ${a.novas} mensagem(ns) nova(s). ` : "";
      const para = !d.pedido_enviado
        ? `O pedido não saiu deste computador (variação ${variacao}): a conexão pode ter caído no meio. Veja wa_estado e tente de novo (há um freio de 30 s por conversa).`
        : !r.chegou
          ? `Não chegou resposta reconhecida do celular em ${segundos} s (variação ${variacao}). Pode ser o celular sem internet ou o WhatsApp não atender este tipo de pedido de um aparelho vinculado; veja \`diagnostico\`. ` +
            `Se a resposta chegar nos próximos 2 minutos, ela é guardada e a próxima chamada desta conversa conta. Tente de novo (há um freio de 30 s por conversa): ${proxima}`
          : r.novas === 0 && r.cortadas === 0
            ? "O celular respondeu, mas não veio nada novo (pode não haver mensagens mais antigas)."
            : `Chegaram ${r.novas} mensagem(ns) mais antigas; leia com wa_ler_conversa.${r.cortadas > 0 ? ` O teto de ${banco.maxMensagens} mensagens por conversa deixou ${r.cortadas} de fora.` : ""}`;
      const semPartida = sintetica
        ? ` Pedido SEM mensagem de partida (experimento, âncora ${sintetica}): o celular ${d.resultado_do_celular === "com_mensagens" ? "mandou mensagens; daqui em diante, a âncora é a real" : d.resultado_do_celular === "vazio" ? "respondeu vazio" : d.resultado_do_celular === "silencio" ? "ficou em silêncio" : "nem recebeu o pedido"}.${r.novas === 0 && ancoraPedida === "auto" ? " A próxima tentativa usa outra âncora." : ""}`
        : "";
      return respostaJson({
        conversa: idPublico,
        pedidas: quantidade,
        ancora_usada: d.ancora,
        resultado_do_celular: d.resultado_do_celular,
        chegou: r.chegou,
        novas: r.novas,
        cortadas_pelo_teto: r.cortadas,
        variacao_usada: variacao,
        pedidos_de_historico_hoje: n.historico,
        limite_diario_de_pedidos: limiteDoDia,
        diagnostico: d,
        ...(a ? { resposta_atrasada_do_pedido_anterior: a } : {}),
        ...(r.pedido_anterior_depois_do_tempo ? { diagnostico_do_pedido_anterior_depois_do_tempo: r.pedido_anterior_depois_do_tempo } : {}),
        para_o_claude: anterior + para + semPartida,
      });
    },
  );
}

/**
 * 0.13.0: o `ate_total`. Começa (ou acompanha) o trabalho em segundo plano desta conversa, no dono da conexão, e volta
 * na hora. Chamar de novo com os mesmos argumentos devolve o progresso; depois de terminado, o resultado uma vez.
 */
function historicoEmSegundoPlano(
  ctx: Contexto,
  banco: Banco,
  e: EntradaIndice,
  ateTotal: number,
  quantidade: number,
  pedida: (typeof VARIACOES_DO_HISTORICO)[number] | "auto",
  limiteDoDia: number,
  ancoraPedida: AncoraSintetica | "auto" = "auto",
) {
  const lotes = ctx.historicoEmLote;
  // Acompanhar um trabalho que já existe não precisa de conexão; começar um novo, sim.
  if (!lotes.andandoEm(e.jid)) {
    if (!banco.lerMensagens(e.jid)[0] && !grupoEscolhidoVazio(banco, e.jid)) throw new Error(SEM_PARTIDA_INDIVIDUAL);
    const t = ctx.exigirDono();
    if (t.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora (veja wa_estado).");
  } else ctx.exigirDono();
  const { progresso: p, novo } = lotes.pedir(e.jid, ateTotal, quantidade, pedida, {
    banco,
    transporte: () => ctx.transporte,
    ancora: (jid) => {
      const a = banco.lerMensagens(jid)[0];
      if (!a) return undefined;
      const participante = ehGrupo(jid) ? participanteDe(a) : undefined;
      return { id: a.id, de_mim: a.de_mim, ts: a.ts, ...(participante ? { participante } : {}) };
    },
    sinteticas: ordemDasSinteticas(ctx, e.jid, ancoraPedida),
    aoPedirSemPartida: (ancora, r) => anotarSemPartida(ctx, e.jid, ancora, r),
    ultimoPedido: ctx.ultimoHistorico,
    limiteDoDia,
    agoraDoDia: ctx.agora,
    esperaMs: ctx.esperaDoHistoricoMs,
  });
  const idPublico = banco.idPublico(e.jid);
  const hoje = banco.contagemDoDia("historico", ctx.agora());
  const outroAlvo = !novo && p.ate_total !== ateTotal;
  const andando = p.situacao === "em_andamento";
  const resumo = `${p.pedidos_feitos} pedido(s) feito(s), ${p.mensagens_novas} mensagem(ns) nova(s), ${p.guardadas_agora} guardada(s) de ${p.ate_total}`;
  const minutos = Math.max(1, Math.ceil((Math.ceil(Math.max(0, p.ate_total - p.guardadas_agora) / quantidade) * 30) / 60));
  const para = andando
    ? (novo
        ? `Começou em segundo plano (${resumo}). Cada pedido espera 30 s depois do anterior: a conversa leva uns ${minutos} min, se o celular atender. `
        : `Em andamento: ${resumo}. `) +
      `Chame wa_buscar_historico de novo com os mesmos argumentos para ver o progresso (não precisa esperar aqui; leia com wa_ler_conversa o que já chegou).${outroAlvo ? ` Este trabalho foi pedido com ate_total ${p.ate_total}: é o que vale até ele terminar.` : ""}`
    : `Terminou: ${FRASE_DA_PARADA[p.parou_porque ?? "erro"]}. ${resumo}.${p.mensagens_novas > 0 ? " Leia com wa_ler_conversa." : ""} Uma nova chamada com \`ate_total\` começa outro trabalho.`;
  return respostaJson({
    conversa: idPublico,
    em_segundo_plano: true,
    situacao: p.situacao,
    ...(andando ? { em_andamento: true } : {}),
    ate_total: p.ate_total,
    pedidas_por_vez: p.pedidas_por_vez,
    guardadas_agora: p.guardadas_agora,
    pedidos_feitos: p.pedidos_feitos,
    mensagens_novas: p.mensagens_novas,
    cortadas_pelo_teto: p.cortadas_pelo_teto,
    pedidos_sem_resposta: p.pedidos_sem_resposta,
    iniciado_em: dataIso(p.iniciado_em),
    ...(p.proximo_pedido_em !== undefined ? { proximo_pedido_em: dataIso(p.proximo_pedido_em) } : {}),
    ...(p.terminado_em !== undefined ? { terminado_em: dataIso(p.terminado_em) } : {}),
    ...(p.parou_porque ? { parou_porque: p.parou_porque } : {}),
    ...(p.ancora_do_ultimo_pedido ? { ancora_do_ultimo_pedido: p.ancora_do_ultimo_pedido } : {}),
    ...(p.pedidos_sem_partida.length > 0 ? { pedidos_sem_partida: p.pedidos_sem_partida } : {}),
    pedidos_de_historico_hoje: hoje,
    limite_diario_de_pedidos: limiteDoDia,
    para_o_claude: para,
  });
}
