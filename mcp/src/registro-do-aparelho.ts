// 0.7.5: o aparelho vinculado se declara pronto para o histórico sob demanda. HIPÓTESE EM TESTE (13/11/2026).
//
// Por quê: o `wa_buscar_historico` funciona com um celular e é ignorado por outro (um iPhone): o servidor dá ack, o
// celular manda o recibo `peer_msg` e não manda mais nada (visto no fio com a 0.7.4). No pareamento, a Baileys
// registra o aparelho com `DeviceProps.historySyncConfig.onDemandReady: undefined`
// (lib/Utils/validate-connection.js, `generateRegistrationNode`), e a config da Baileys não expõe esse campo. A
// hipótese é que o iPhone só atende pedido sob demanda de aparelho que se declarou pronto.
//
// Como: embrulha `proto.DeviceProps.encode` (uma vez só) para que toda codificação de `DeviceProps` saia com
// `historySyncConfig.onDemandReady = true`, numa cópia rasa (o objeto recebido não muda). Os outros campos, inclusive
// `completeOnDemandReady`, ficam como a Baileys mandou. Só vale para pareamento feito DEPOIS do embrulho: a sessão já
// pareada continua registrada como foi.
//
// Desligar: `WA_SEM_ON_DEMAND_READY=1` no ambiente do servidor (lido em config.ts, `semOnDemandReady`); com ela a
// função não embrulha nada. Se a hipótese cair, apague este arquivo e as duas chamadas (stdio.ts e transporte.ts).

import { proto } from "@whiskeysockets/baileys";
import { semOnDemandReady } from "./config.ts";

type Codificar = typeof proto.DeviceProps.encode;

/** O `encode` da Baileys, guardado no primeiro embrulho (para restaurar nos testes). */
let encodeOriginal: Codificar | undefined;

/** Este processo está com o embrulho ativo? */
export function declarouProntoParaHistorico(): boolean {
  return encodeOriginal !== undefined;
}

/**
 * Embrulha `proto.DeviceProps.encode`, se ainda não estiver embrulhado e o desligamento não estiver ligado.
 * Devolve se o embrulho está ativo depois da chamada. Chamar de novo não embrulha outra vez.
 */
export function declararProntoParaHistoricoSobDemanda(desligado: boolean = semOnDemandReady()): boolean {
  if (encodeOriginal !== undefined) return true;
  if (desligado) return false;
  const original = proto.DeviceProps.encode;
  encodeOriginal = original;
  const embrulhado: Codificar = (mensagem, escritor) => {
    const config = mensagem.historySyncConfig;
    const comPronto: proto.IDeviceProps = {
      ...mensagem,
      historySyncConfig: config ? { ...config, onDemandReady: true } : { onDemandReady: true },
    };
    return original.call(proto.DeviceProps, comPronto, escritor);
  };
  proto.DeviceProps.encode = embrulhado;
  return true;
}

/** Só para os testes: devolve o `encode` original da Baileys e desfaz o embrulho. */
export function restaurarEncodeOriginal(): void {
  if (encodeOriginal === undefined) return;
  proto.DeviceProps.encode = encodeOriginal;
  encodeOriginal = undefined;
}
