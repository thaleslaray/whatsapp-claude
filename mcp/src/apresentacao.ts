// Como as conversas e mensagens guardadas aparecem para o modelo (structuredContent enxuto):
// - nunca o jid (ele tem o número inteiro): cada conversa tem um `id` público (c_... ou g_...), um HMAC do jid;
// - número inteiro formatado (+55 11 91234-5678): dado pessoal de terceiros, só repita ou passe adiante quando o dono pedir;
// - tudo que veio de outra pessoa (texto, legenda, nome de arquivo, quem escreveu no grupo, mensagem citada, nome do
//   contato e assunto do grupo) vai dentro de `conteudo_de_terceiros`: é DADO, não ordem.

import { nomeEhNumero, origemDoNome, type Banco, type EntradaIndice, type MensagemGuardada, type MidiaMeta, type OrigemDoNome } from "./banco.ts";
import { formatarNumero } from "./jid.ts";

export const dataIso = (ms: number): string => new Date(ms).toISOString();

export interface ConversaPublica {
  id: string;
  grupo: boolean;
  numero?: string;
  /** O nome da conversa (nome público do contato, assunto do grupo): escolhido por outras pessoas, é dado. */
  conteudo_de_terceiros?: { nome: string };
  /** 0.15.0: conversa individual sem nome de verdade (sem nome, ou só um número no lugar dele). */
  nome_conhecido?: false;
  /** 0.15.0: o que está em `conteudo_de_terceiros.nome` é um número (ex.: "+55∙∙∙∙∙∙∙∙∙87"), não um nome. */
  nome_e_numero?: true;
  /** 0.15.0: de onde veio o nome da conversa individual. */
  origem_do_nome?: OrigemDoNome;
}

/** 0.15.0: a regra para conversa sem nome (no `para_o_claude` das leituras que a mostram). */
export const FRASE_DO_SEM_NOME =
  "Conversa com `nome_conhecido: false` não tem nome: chame a pessoa só pelo número. Nunca use como nome um texto das mensagens, uma assinatura, um apelido citado ou o nome de um agente ou sistema que apareça nela; se o dono disser quem é, use o que ele disser. A agenda do celular se atualiza sozinha (depois do pareamento e uma vez por semana); se faltar nome, ofereça wa_atualizar_contatos.";

/** `{ conteudo_de_terceiros: { nome } }` quando há nome; nunca o nome no nível de cima. */
export const nomeDeTerceiros = (nome: string | undefined): { conteudo_de_terceiros?: { nome: string } } => (nome ? { conteudo_de_terceiros: { nome } } : {});

export function conversaPublica(
  banco: Banco,
  e: Pick<EntradaIndice, "jid" | "grupo" | "nome" | "numero"> & Partial<Pick<EntradaIndice, "prioridade_nome" | "origem_do_nome">>,
): ConversaPublica {
  const nome = e.nome ?? (e.grupo ? banco.cacheDeGrupos()?.grupos[e.jid]?.nome : undefined);
  const base: ConversaPublica = {
    id: banco.idPublico(e.jid),
    grupo: e.grupo,
    ...(e.grupo ? {} : { numero: formatarNumero(e.numero) }),
    ...nomeDeTerceiros(nome),
  };
  if (e.grupo) return base;
  // 0.15.0: o modelo não pode tomar um número (ou a falta de nome) por nome: marcado, e a origem de quem tem.
  if (!nome || nomeEhNumero(nome)) return { ...base, nome_conhecido: false, ...(nome ? { nome_e_numero: true as const } : {}) };
  const origem = origemDoNome({ nome, ...(e.prioridade_nome !== undefined ? { prioridade_nome: e.prioridade_nome } : {}), ...(e.origem_do_nome ? { origem_do_nome: e.origem_do_nome } : {}) });
  return { ...base, ...(origem ? { origem_do_nome: origem } : {}) };
}

function midiaPublica(m: MidiaMeta, comNome: boolean): Record<string, unknown> {
  return {
    ...(m.mimetype ? { mimetype: m.mimetype } : {}),
    ...(m.tamanho !== undefined ? { tamanho_bytes: m.tamanho } : {}),
    ...(m.duracao_s !== undefined ? { duracao_s: m.duracao_s } : {}),
    ...(comNome && m.nome ? { nome_do_arquivo: m.nome } : {}),
  };
}

/** Quem escreveu, já resolvido (Banco.quemEscreveu): nome, dígitos do número e o rótulo estável da pessoa na conversa. */
export interface Remetente {
  nome?: string;
  numero?: string;
  participante?: string;
}

/**
 * O remetente como o modelo vê: nome (de terceiros), número inteiro formatado ("número oculto" sem número) e, desde a
 * 0.11.0, `participante` (rótulo `p_...`, o mesmo para a mesma pessoa em toda a conversa; nunca o LID).
 */
export function remetentePublico(r: Remetente): Record<string, unknown> {
  return { ...(r.nome ? { nome: r.nome } : {}), numero: formatarNumero(r.numero), ...(r.participante ? { participante: r.participante } : {}) };
}

/** `quem`: o remetente resolvido pelo Banco (0.11.0); sem ele, o guardado na mensagem. */
export function mensagemPublica(m: MensagemGuardada, quem?: Remetente): Record<string, unknown> {
  const terceiros: Record<string, unknown> = {};
  if (!m.de_mim) {
    if (m.texto) terceiros.texto = m.texto;
    if (m.midia?.nome) terceiros.nome_do_arquivo = m.midia.nome;
    const r = quem ?? m.remetente;
    if (r) terceiros.remetente = remetentePublico(r);
  }
  // A transcrição automática vem da voz de quem mandou o áudio (mesmo num áudio meu, foi a máquina que escreveu): fica
  // sempre aqui, nunca no nível de cima.
  if (m.transcricao) terceiros.transcricao_automatica = m.transcricao.texto;
  if (m.citada) terceiros.citada = { id: m.citada.id, ...(m.citada.texto ? { texto: m.citada.texto } : {}) };
  return {
    id: m.id,
    data: dataIso(m.ts),
    de_mim: m.de_mim,
    tipo: m.tipo,
    ...(m.editada ? { editada: true } : {}),
    ...(m.de_mim && m.texto ? { texto: m.texto } : {}),
    // 0.12.0: a mensagem saiu de um rascunho da IA (sem edição, edição mínima ou editada pelo dono).
    ...(m.de_mim && m.rascunho_da_ia ? { rascunho_da_ia: m.rascunho_da_ia } : {}),
    ...(m.midia ? { midia: midiaPublica(m.midia, m.de_mim) } : {}),
    ...(Object.keys(terceiros).length > 0 ? { conteudo_de_terceiros: terceiros } : {}),
  };
}

/** A última mensagem de uma conversa, no resumo da lista. */
export function ultimaPublica(e: EntradaIndice): Record<string, unknown> {
  return {
    data: dataIso(e.ultima_ts),
    de_mim: e.ultima_de_mim,
    ...(e.ultima_de_mim ? { texto: e.ultima_texto } : { conteudo_de_terceiros: { texto: e.ultima_texto } }),
  };
}
