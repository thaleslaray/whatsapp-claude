// 0.17.0: wa_responder_lote. UM cartão com várias respostas, para várias conversas, aprovadas com um clique.
// As garantias do wa_responder valem item a item e são conferidas ANTES do cartão (conversa existente ou grupo escolhido,
// fora da lista "nunca ler", envio ligado, citação que existe) e de novo no clique. O limite do dia conta cada mensagem
// como 1 e o lote inteiro tem de caber no que resta. Nada sai sem o clique.
//
// O cartão edita a DECISÃO do dono: o "texto" do pedido é o JSON canônico { enviar, mensagens } (ui/edicao.js). Assim o
// mecanismo do texto editável (código preso ao texto, wa_confirmar com `texto`) vale sem mudar: o modelo nunca aprova
// uma decisão que o dono não viu. Envio em sequência: cada mensagem tem o "digitando…" de 1 a 3 s do transporte, que
// faz a pausa entre elas. Um item que falha não derruba os outros; dentro do item, falhou uma mensagem, as seguintes
// daquele item não saem (a ordem importa).

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { lerLote, serializarLote } from "../../ui/edicao.js";
import { dataIso } from "../apresentacao.ts";
import { descricaoCurta } from "../banco.ts";
import type { Previa } from "../confirmacao.ts";
import type { Contexto } from "../contexto.ts";
import { ehGrupo } from "../jid.ts";
import { marcaDoRascunho } from "../jeito.ts";
import { registrarEscrita } from "../respostas.ts";
import type { Citacao } from "../transporte.ts";
import { alvoDe, ENVIO_DESLIGADO, LIMITE_DO_TEXTO, participanteDe, participantesDoGrupo, resolverParaEscrever, validarTexto } from "./escrita.ts";
import { aprenderComOEnvio, contarDesistencia } from "./jeito.ts";

export const MAXIMO_DE_ITENS_DO_LOTE = 10;
export const MAXIMO_DE_MENSAGENS_POR_ITEM = 5;
/** Folga do JSON da decisão (marcas, aspas, escapes) acima do maior lote possível. */
const LIMITE_DA_DECISAO = MAXIMO_DE_ITENS_DO_LOTE * MAXIMO_DE_MENSAGENS_POR_ITEM * LIMITE_DO_TEXTO * 6 + 10_000;

interface ItemDoCorpo {
  jid: string;
  /** Id público da conversa (o registro de ações nunca leva o número). */
  id: string;
  citar?: Citacao;
  /** O que o Claude propôs, na ordem. */
  propostas: string[];
}

interface CorpoDoLote {
  itens: ItemDoCorpo[];
  /** A decisão do dono: item marcado ("enviar este") ou não. */
  enviar: boolean[];
  /** O texto de cada mensagem de cada item, como vai sair (talvez editado). */
  finais: string[][];
}

interface ResultadoDoItem {
  conversa: string;
  estado: "enviado" | "parcial" | "falhou" | "nao_enviado";
  enviadas: number;
  de: number;
  mensagem_ids: string[];
  frase: string;
  erro?: string;
}

const plural = (n: number, um: string, varios: string): string => `${n} ${n === 1 ? um : varios}`;

export function registrarLote(server: McpServer, ctx: Contexto): void {
  registrarEscrita(
    server,
    ctx.pedidos,
    "wa_responder_lote",
    { destrutiva: false, idempotente: false },
    {
      title: "Responder várias conversas de uma vez (com um clique)",
      description:
        `Prepara respostas para VÁRIAS conversas (de 1 a ${MAXIMO_DE_ITENS_DO_LOTE}) e mostra tudo num cartão só, que o dono aprova com um clique em "Enviar todas". ` +
        "Cada item tem `conversa` (id de wa_listar_conversas, nome único ou número; individual ou grupo ESCOLHIDO, como no wa_responder), " +
        `\`mensagens\` (de 1 a ${MAXIMO_DE_MENSAGENS_POR_ITEM} textos, cada um vira uma mensagem separada, na ordem; até ${LIMITE_DO_TEXTO} caracteres cada) e \`citar\` (opcional, id de mensagem da conversa; só a primeira mensagem do item cita). ` +
        "O cartão mostra, por conversa, quem é (e quantos participantes, se for grupo), a última mensagem recebida (só para ler) e as mensagens em caixas que o dono pode editar; " +
        "cada item tem uma caixa de marcar, marcada por padrão, para tirar uma conversa sem cancelar o resto. Envia SÓ depois do clique, em sequência, com o \"digitando…\" de sempre entre as mensagens. " +
        "Recusa o lote inteiro, antes do cartão, se algum item não vale (grupo fora da lista, conversa desconhecida ou da lista \"nunca ler\", citação que não existe, a mesma conversa duas vezes), " +
        "se o envio estiver desligado (veja wa_envio) ou se o lote não couber no limite do dia (cada mensagem conta 1; a recusa diz quantas cabem). " +
        "Depois do clique, o cartão mostra o resultado de cada item (enviado ou falhou, e por quê). " +
        'Exemplo: "responde o Leonardo, minha mãe e a Jhenifer de uma vez".',
      inputSchema: z.strictObject({
        itens: z
          .array(
            z.strictObject({
              conversa: z.string().trim().min(1).max(200).describe("id (c_... ou g_...), nome único ou número da conversa"),
              mensagens: z
                .array(z.string().min(1).max(20_000))
                .min(1)
                .max(MAXIMO_DE_MENSAGENS_POR_ITEM)
                .describe(`De 1 a ${MAXIMO_DE_MENSAGENS_POR_ITEM} textos; cada um vira uma mensagem separada, na ordem (até ${LIMITE_DO_TEXTO} caracteres cada)`),
              citar: z.string().trim().min(1).max(100).optional().describe("id de uma mensagem desta conversa para citar (só a primeira mensagem do item cita)"),
            }),
          )
          .min(1)
          .max(MAXIMO_DE_ITENS_DO_LOTE)
          .describe(`De 1 a ${MAXIMO_DE_ITENS_DO_LOTE} conversas, cada uma com as suas mensagens`),
      }),
    },
    async ({ itens }, _mcp, escrever) => {
      const { banco } = await ctx.nucleo();
      // Tudo recusado ANTES da prévia.
      if (!banco.envioLigado()) throw new Error(ENVIO_DESLIGADO);
      const t = ctx.exigirDono();
      if (t.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora (veja wa_estado). Nada foi preparado.");
      const limite = ctx.config.limiteDiario;
      const hoje = banco.enviosDoDia(ctx.agora());
      const restante = Math.max(0, limite - hoje);
      const total = itens.reduce((n, i) => n + i.mensagens.length, 0);
      if (total > restante) {
        throw new Error(
          `O lote tem ${plural(total, "mensagem", "mensagens")} e o limite do dia (${limite}) deixa ${plural(restante, "mensagem", "mensagens")} (${hoje} hoje): ${
            restante === 0 ? "não cabe nenhuma" : `cabem só ${restante}`
          }. Nada foi preparado; reduza o lote ou espere o limite voltar amanhã.`,
        );
      }

      const corpoItens: ItemDoCorpo[] = [];
      const fixos: NonNullable<Previa["lote"]> = [];
      const deTerceiros: NonNullable<NonNullable<Previa["conteudo_de_terceiros"]>["lote"]> = [];
      const vistos = new Set<string>();
      for (const [indice, item] of itens.entries()) {
        const rotulo = `Item ${indice + 1} (${item.conversa})`;
        try {
          const e = resolverParaEscrever(banco, item.conversa, { grupoEscolhidoVazio: true });
          if (vistos.has(e.jid)) throw new Error("essa conversa já aparece em outro item do lote: junte as mensagens num item só. Nada foi preparado.");
          vistos.add(e.jid);
          for (const texto of item.mensagens) validarTexto(texto);
          const guardadas = banco.lerMensagens(e.jid);
          let citacao: Citacao | undefined;
          if (item.citar) {
            const m = guardadas.find((x) => x.id === item.citar);
            if (!m) throw new Error("não achei essa mensagem para citar nesta conversa (use o id de wa_ler_conversa). Nada foi preparado.");
            const participante = e.grupo ? participanteDe(m) : undefined;
            if (e.grupo && !m.de_mim && !participante) throw new Error("não sei quem escreveu essa mensagem do grupo, e a citação precisa disso. Tire a citação. Nada foi preparado.");
            citacao = { id: m.id, de_mim: m.de_mim, ...(m.texto ? { texto: m.texto } : {}), ...(participante ? { participante } : {}) };
          }
          const participantes = e.grupo ? await participantesDoGrupo(ctx, banco, e.jid) : undefined;
          const nome = e.nome ?? (e.grupo ? banco.cacheDeGrupos()?.grupos[e.jid]?.nome : undefined);
          const ultima = guardadas.filter((m) => !m.de_mim).at(-1);
          corpoItens.push({ jid: e.jid, id: banco.idPublico(e.jid), ...(citacao ? { citar: citacao } : {}), propostas: [...item.mensagens] });
          fixos.push({
            alvo: alvoDe(banco, e),
            ...(e.grupo ? { destaque: `GRUPO: ${participantes ? `${participantes} participantes vão receber` : "todos os participantes vão receber (não consegui saber quantos)"}` } : {}),
          });
          deTerceiros.push({
            ...(nome ? { nome } : {}),
            ...(ultima ? { ultima: { data: dataIso(ultima.ts), texto: descricaoCurta(ultima).slice(0, 300) } } : {}),
            ...(citacao ? { citada: citacao.texto ? citacao.texto.slice(0, 500) : "[mensagem sem texto]" } : {}),
          });
        } catch (erro) {
          throw new Error(`${rotulo}: ${erro instanceof Error ? erro.message : String(erro)}`);
        }
      }

      const propostas = corpoItens.map((i) => i.propostas);
      const textoDaDecisao = serializarLote(corpoItens.map(() => true), propostas);
      const ids = corpoItens.map((i) => i.id);
      const quantas = plural(corpoItens.length, "conversa", "conversas");
      const previa: Previa = {
        tipo: "responder_lote",
        titulo: `Responder em ${quantas}`,
        alvo: quantas,
        texto: textoDaDecisao,
        lote: fixos,
        conteudo_de_terceiros: { lote: deTerceiros },
        detalhes: [
          `Respostas hoje: ${hoje} de ${limite}. Este lote usa até ${plural(total, "mensagem", "mensagens")}.`,
          "Cada mensagem aparece como “digitando…” por 1 a 3 s antes de sair, uma depois da outra. Você não aparece online.",
        ],
        botao: `Enviar todas (${corpoItens.length})`,
      };
      const corpo: CorpoDoLote = { itens: corpoItens, enviar: corpoItens.map(() => true), finais: propostas.map((p) => [...p]) };
      let idDoPedido = "";

      const comTexto = (novo: string): CorpoDoLote => {
        const d = lerLote(novo);
        if (d.enviar.length !== corpoItens.length) throw new Error("A decisão do lote não tem o mesmo número de conversas da prévia. Nada foi enviado.");
        for (const [i, item] of corpoItens.entries()) {
          if (d.mensagens[i]!.length !== item.propostas.length) throw new Error(`O item ${i + 1} mudou o número de mensagens; só o texto de cada uma pode mudar. Nada foi enviado.`);
          if (d.enviar[i]) d.mensagens[i]!.forEach((m, k) => {
            try {
              validarTexto(m);
            } catch (erro) {
              throw new Error(`Item ${i + 1}, mensagem ${k + 1}: ${erro instanceof Error ? erro.message : String(erro)}`);
            }
          });
        }
        if (!d.enviar.some(Boolean)) throw new Error("Nenhuma conversa está marcada para enviar. Nada foi enviado.");
        return { itens: corpoItens, enviar: d.enviar, finais: d.mensagens };
      };

      const r = await escrever(
        "wa_responder_lote",
        corpo,
        previa,
        async (c) => {
          // Conferido de novo no clique, antes de qualquer envio.
          if (!banco.envioLigado()) throw new Error("O envio foi desligado depois da prévia. Nada foi enviado.");
          const tr = ctx.exigirDono();
          if (tr.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora. Nada foi enviado.");
          let aEnviar = 0;
          for (const [i, item] of c.itens.entries()) {
            if (!c.enviar[i]) continue;
            if (banco.estaBloqueado(item.jid)) throw new Error(`A conversa ${item.id} entrou na lista "nunca ler" depois da prévia. Nada foi enviado.`);
            if (ehGrupo(item.jid) && !banco.grupoPermitido(item.jid)) throw new Error(`O grupo ${item.id} saiu da lista de escolhidos depois da prévia. Nada foi enviado.`);
            aEnviar += item.propostas.length;
          }
          const agoraNoLimite = banco.enviosDoDia(ctx.agora());
          if (agoraNoLimite + aEnviar > limite) {
            const cabem = Math.max(0, limite - agoraNoLimite);
            throw new Error(`O limite de ${limite} respostas por dia já não comporta o lote: ${plural(aEnviar, "mensagem", "mensagens")} marcadas, cabem ${cabem} (${agoraNoLimite} hoje). Nada foi enviado.`);
          }

          const resultados: ResultadoDoItem[] = [];
          let contadas = agoraNoLimite;
          for (const [i, item] of c.itens.entries()) {
            const de = item.propostas.length;
            if (!c.enviar[i]) {
              resultados.push({ conversa: item.id, estado: "nao_enviado", enviadas: 0, de, mensagem_ids: [], frase: `${item.id}: desmarcada, nada enviado.` });
              continue;
            }
            const ids: string[] = [];
            let erro: string | undefined;
            for (const [k, texto] of c.finais[i]!.entries()) {
              try {
                contadas = banco.reservarEnvio(ctx.agora(), limite);
                const enviada = await tr.responder(item.jid, texto, k === 0 ? item.citar : undefined, { rascunho: marcaDoRascunho(item.propostas[k]!, texto) });
                ids.push(enviada.id);
                aprenderComOEnvio(banco, { conversa: item.jid, mensagem_id: enviada.id, ferramenta: "wa_responder", rascunho: item.propostas[k]!, enviado: texto, em: enviada.ts });
                ctx.registro.gravar({
                  evento: "enviado",
                  pedido: idDoPedido,
                  ferramenta: "wa_responder_lote",
                  alvo: item.id,
                  conversa: item.id,
                  mensagem_id: enviada.id,
                  ordem: k + 1,
                  de,
                  caracteres: [...texto].length,
                  ...(texto !== item.propostas[k] ? { editado: true } : {}),
                });
              } catch (e) {
                erro = e instanceof Error ? e.message : String(e);
                ctx.registro.gravar({ evento: "erro", pedido: idDoPedido, ferramenta: "wa_responder_lote", alvo: item.id, conversa: item.id, ordem: k + 1, de, resultado: { erro } });
                break;
              }
            }
            const estado = erro === undefined ? "enviado" : ids.length > 0 ? "parcial" : "falhou";
            resultados.push({
              conversa: item.id,
              estado,
              enviadas: ids.length,
              de,
              mensagem_ids: ids,
              ...(erro !== undefined ? { erro } : {}),
              frase: erro === undefined ? `${item.id}: enviado (${plural(de, "mensagem", "mensagens")}).` : `${item.id}: falhou na mensagem ${ids.length + 1} de ${de} (${ids.length} enviada(s)): ${erro}`,
            });
          }
          const enviadas = resultados.reduce((n, x) => n + x.enviadas, 0);
          const frase = `${enviadas > 0 ? `Lote: ${plural(enviadas, "mensagem enviada", "mensagens enviadas")}.` : "Lote: nada foi enviado."} Respostas hoje: ${contadas} de ${limite}.\n${resultados.map((x) => x.frase).join("\n")}`;
          if (enviadas === 0 && c.enviar.some(Boolean)) throw new Error(frase);
          return { itens: resultados, mensagens_enviadas: enviadas, respostas_hoje: contadas, limite_diario: limite, frase };
        },
        { limite: LIMITE_DA_DECISAO, unidade: "caracteres", comTexto },
        { alvoParaOClaude: quantas, registro: { alvo: `lote de ${quantas}`, conversas: ids }, aoDesistir: contarDesistencia(banco) },
      );
      const id = (r.structuredContent as { pedido?: unknown } | undefined)?.pedido;
      if (typeof id === "string") idDoPedido = id;
      return r;
    },
  );
}
