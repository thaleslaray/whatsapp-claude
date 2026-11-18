// 0.15.0: os nomes dos contatos. Parte da agenda do celular nunca chegava, e uma conversa sem nome levou o modelo a usar
// uma frase da conversa como nome. wa_atualizar_contatos (escrita local direta, sem cartão: não manda nada a ninguém, só
// pede ao celular do próprio dono) pede de novo a agenda do WhatsApp (agenda.ts e transporte.atualizarContatos) e diz o
// que mudou. Desde a 0.15.1 a agenda também se atualiza sozinha (depois do pareamento e uma vez por semana, agenda.ts):
// a ferramenta fica para quando faltar nome. Freio: um a cada 10 min, 6 por dia, contados junto com os automáticos (a
// contagem do dia fica no envios.enc, como as outras). Só o dono da conexão executa; o leitor repassa.
// Nada de nome ou telefone em log, registro de ações ou caixa-preta: só contagens.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { minutosDoFreio, ressincronizarAgenda } from "../agenda.ts";
import { ATUALIZACOES_DE_CONTATOS_POR_DIA } from "../config.ts";
import type { Contexto } from "../contexto.ts";
import { registrarEscritaDireta, respostaJson } from "../respostas.ts";

export function registrarContatos(server: McpServer, ctx: Contexto): void {
  registrarEscritaDireta(
    server,
    "wa_atualizar_contatos",
    { destrutiva: false, idempotente: false },
    {
      title: "Pedir de novo a agenda ao celular",
      description:
        "Pede ao celular do dono, de novo e desde o começo, a agenda de contatos do WhatsApp (os nomes que o dono salvou) e grava os nomes que chegarem: o da agenda vence o nome público. " +
        "A agenda já se atualiza sozinha depois do pareamento e uma vez por semana: use esta quando faltar nome (o dono pedir, ou estranhar conversas sem nome). " +
        "Não manda nada a ninguém. Espera uns 20 s e diz quantos contatos chegaram, quantos nomes entraram ou mudaram, quantas conversas guardadas ganharam nome e quantas conversas individuais continuam sem nome. " +
        `Freio: um pedido a cada 10 min e ${ATUALIZACOES_DE_CONTATOS_POR_DIA} por dia, contando os automáticos. Contato da lista "nunca ler" não ganha nome guardado. ` +
        'Exemplos: "atualiza os nomes dos meus contatos", "por que essa conversa está sem nome?".',
      inputSchema: z.strictObject({}),
    },
    async () => {
      const { banco } = await ctx.nucleo();
      const t = ctx.exigirDono();
      if (t.estado().situacao !== "conectado") throw new Error("O WhatsApp não está conectado agora (veja wa_estado). Nada foi pedido.");
      const faltam = minutosDoFreio(ctx, ctx.agora());
      if (faltam !== undefined) {
        throw new Error(`Já pedi a agenda ao celular há pouco: espere 10 min entre um pedido e outro (falta${faltam === 1 ? "" : "m"} ${faltam} min). Nada foi pedido.`);
      }
      const { r, hoje, conversas_que_ganharam_nome: ganharam, conversas_individuais_sem_nome: semNomeDepois } = await ressincronizarAgenda(ctx, banco, t, "pedido");
      const contagens = {
        contatos_recebidos: r.contatos_recebidos,
        nomes_novos: r.nomes_novos,
        nomes_atualizados: r.nomes_atualizados,
        conversas_que_ganharam_nome: ganharam,
        conversas_individuais_sem_nome: semNomeDepois,
      };
      ctx.registro.gravar({ acao: "wa_atualizar_contatos", pedido_enviado: r.pedido_enviado, terminou: r.terminou, ...contagens });
      const segundos = Math.round(r.espera_ms / 1000);
      const para = r.tempo_esgotado
        ? `O celular não terminou de mandar a agenda em ${segundos} s. ${r.contatos_recebidos > 0 ? `Chegaram ${r.contatos_recebidos} contato(s) até aqui; ` : ""}o que chegar depois também é guardado. Pode ser o celular sem internet: tente de novo mais tarde (há um freio de 10 min).`
        : r.erro
          ? `O celular respondeu com erro (${r.erro}): ${r.contatos_recebidos} contato(s) chegaram. Tente de novo mais tarde (há um freio de 10 min).`
          : `A agenda chegou: ${r.contatos_recebidos} contato(s), ${r.nomes_novos} nome(s) novo(s), ${r.nomes_atualizados} atualizado(s); ${ganharam} conversa(s) guardada(s) ganharam nome.`;
      const semNome = semNomeDepois > 0 ? ` ${semNomeDepois} conversa(s) individuais continuam sem nome: chame-as só pelo número, ou pergunte ao dono quem é.` : "";
      return respostaJson({
        ...contagens,
        terminou: r.terminou,
        ...(r.tempo_esgotado ? { tempo_esgotado: true } : {}),
        ...(r.erro ? { erro_do_celular: r.erro } : {}),
        pedidos_da_agenda_hoje: hoje,
        limite_diario_de_pedidos_da_agenda: ATUALIZACOES_DE_CONTATOS_POR_DIA,
        para_o_claude: para + semNome,
      });
    },
  );
}
