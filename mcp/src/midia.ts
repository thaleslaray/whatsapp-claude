// Mídia: na v1 só os metadados são guardados (baixar fica para a v2). Estas travas já valem para o download:
// adaptadas do Nod (Apache-2.0), `read()` em engine/src/providers/chat-sdk/whatsapp.ts:215-262.

export const MAXIMO_DE_MIDIA_BYTES = 50 * 1024 * 1024; // Nod whatsapp.ts:238 e 254, 50 MB
export const TEMPO_LIMITE_DE_MIDIA_MS = 60_000; // Nod whatsapp.ts:218, AbortSignal.timeout(60_000)
/** O download da v2 passa estas opções ao fetch: sem seguir redirecionamento. Nod whatsapp.ts:243. */
export const OPCOES_DE_DOWNLOAD = { redirect: "error" } as const;

/**
 * Endereço de mídia aceito: https, sem usuário, senha nem porta, só mmg.whatsapp.net ou mmg-fna.whatsapp.net
 * (Nod whatsapp.ts:222-232); `directPath` precisa começar com uma única barra (Nod whatsapp.ts:233-237).
 * Precisa de pelo menos um dos dois.
 */
export function enderecoDeMidiaValido(url: string | null | undefined, directPath?: string | null): boolean {
  // Sem url nem directPath não há de onde baixar.
  if (!url && !directPath) return false;
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port || !/^(mmg|mmg-fna)\.whatsapp\.net$/.test(u.hostname)) return false;
  }
  if (directPath && (!directPath.startsWith("/") || directPath.startsWith("//"))) return false;
  return true;
}

// ---- 0.7.0, parte 2: abrir a mídia recebida e enviar arquivos ----
// Baixar: endereço montado do `directPath` (o mesmo que a Baileys faz em downloadContentFromMessage: a `url` guardada só
// dá o host), `fetch` sem seguir redirecionamento e com tempo limite (as travas do Nod acima), tamanho conferido antes
// (o declarado) e durante (os bytes que chegam). Decifrar aqui, sem o downloadContentFromMessage da Baileys: ele não
// deixa recusar redirecionamento e não confere o HMAC nem os hashes. Aqui: hash do arquivo cifrado (se guardado), HMAC
// de 10 bytes (sempre), AES-256-CBC e hash do arquivo decifrado (se guardado). As chaves vêm do getMediaKeys da Baileys.

import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { posix, win32 } from "node:path";
import { getMediaKeys, type MediaType } from "@whiskeysockets/baileys";

/** Imagem até este tamanho volta como bloco de imagem do MCP (o modelo vê). Em base64 (~1,4 MB) cabe no canal (2 MB). */
export const IMAGEM_EM_LINHA_MAXIMA_BYTES = 1024 * 1024;
/** Tipos que o bloco de imagem aceita (os que o Claude lê). */
export const IMAGEM_EM_LINHA_TIPOS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export { ABERTURAS_POR_DIA } from "./config.ts";
/** Documento de texto até este tamanho também volta como texto (em conteudo_de_terceiros). */
export const TEXTO_DE_DOCUMENTO_MAXIMO_BYTES = 100 * 1024;
export const TIPOS_DE_TEXTO = new Set(["text/plain", "text/csv", "application/json", "text/markdown", "text/x-markdown"]);
/** Envio: teto do WhatsApp para imagem, vídeo e áudio (16 MB) e o nosso para documento (100 MB). */
export const ENVIO_MIDIA_MAXIMO_BYTES = 16 * 1024 * 1024;
export const ENVIO_DOCUMENTO_MAXIMO_BYTES = 100 * 1024 * 1024;
/** Quanto se espera o celular reenviar uma mídia vencida (updateMediaMessage). */
export const ESPERA_DO_REENVIO_MS = 30_000;
const HOST_PADRAO = "mmg.whatsapp.net";
const ORIGEM = "https://web.whatsapp.com";

/** Downloads/WhatsApp Claude dentro da casa (Mac, Windows e Linux). Pura: plataforma e casa injetáveis. */
export function pastaDeDownloadsPadrao(plataforma: NodeJS.Platform, casa: string): string {
  return plataforma === "win32" ? win32.join(casa, "Downloads", "WhatsApp Claude") : posix.join(casa, "Downloads", "WhatsApp Claude");
}

/** Erro de HTTP do servidor de mídia (404/410 = vencida: pedir reenvio ao celular). */
export class ErroDeMidia extends Error {
  override name = "ErroDeMidia";
  readonly status: number | undefined;
  constructor(mensagem: string, status?: number) {
    super(mensagem);
    this.status = status;
  }
}

/** O tipo da Baileys (chaves HKDF e nome do campo da mensagem) de cada tipo guardado. */
export function tipoDaBaileys(tipo: string): Extract<MediaType, "image" | "video" | "audio" | "document" | "sticker"> | undefined {
  return ({ imagem: "image", video: "video", audio: "audio", nota_de_voz: "audio", documento: "document", figurinha: "sticker" } as const)[tipo as "imagem"];
}

/** O endereço de onde baixar: host da `url` guardada (se aceita) ou o padrão, mais o `directPath`. */
export function enderecoParaBaixar(caminho: string, url?: string): string | undefined {
  if (!enderecoDeMidiaValido(url, caminho)) return undefined;
  const host = url ? new URL(url).hostname : HOST_PADRAO;
  return `https://${host}${caminho}`;
}

/** Baixa o arquivo cifrado: sem redirecionamento, com tempo limite e teto de bytes conferido enquanto chega. */
export async function baixarCifrado(url: string, buscar: typeof fetch, maximoDecifrado: number): Promise<Buffer> {
  // O cifrado tem até 16 bytes de enchimento e 10 de HMAC a mais que o decifrado.
  const teto = maximoDecifrado + 32;
  const r = await buscar(url, { ...OPCOES_DE_DOWNLOAD, signal: AbortSignal.timeout(TEMPO_LIMITE_DE_MIDIA_MS), headers: { Origin: ORIGEM } });
  if (!r.ok) throw new ErroDeMidia(`O servidor de mídia do WhatsApp respondeu ${r.status}.`, r.status);
  const declarado = Number(r.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declarado) && declarado > teto) throw new ErroDeMidia(`A mídia passa do teto de ${megas(maximoDecifrado)}. Nada foi gravado.`);
  if (!r.body) throw new ErroDeMidia("O servidor de mídia não mandou o arquivo.");
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of r.body as unknown as AsyncIterable<Uint8Array>) {
    total += parte.length;
    if (total > teto) throw new ErroDeMidia(`A mídia passa do teto de ${megas(maximoDecifrado)} (chegou mais do que o declarado). Parei o download; nada foi gravado.`);
    partes.push(Buffer.from(parte));
  }
  return Buffer.concat(partes);
}

const megas = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

const igual = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Confere e decifra um arquivo de mídia do WhatsApp (AES-256-CBC + HMAC-SHA256 de 10 bytes no fim). */
export async function decifrarMidia(
  cifrado: Buffer,
  chaveB64: string,
  tipo: Extract<MediaType, "image" | "video" | "audio" | "document" | "sticker">,
  hashes: { sha256?: string; sha256_cifrado?: string } = {},
): Promise<Buffer> {
  const NAO_CONFERE = "O arquivo baixado não confere com o que o WhatsApp mandou (corrompido ou trocado). Nada foi gravado.";
  if (hashes.sha256_cifrado && !igual(createHash("sha256").update(cifrado).digest(), Buffer.from(hashes.sha256_cifrado, "base64"))) throw new ErroDeMidia(NAO_CONFERE);
  if (cifrado.length < 26 || (cifrado.length - 10) % 16 !== 0) throw new ErroDeMidia(NAO_CONFERE);
  const chaves = await getMediaKeys(Buffer.from(chaveB64, "base64"), tipo);
  const iv = chaves.iv!;
  const cipherKey = chaves.cipherKey!;
  const macKey = chaves.macKey!;
  const corpo = cifrado.subarray(0, cifrado.length - 10);
  const mac = cifrado.subarray(cifrado.length - 10);
  if (!igual(createHmac("sha256", macKey).update(iv).update(corpo).digest().subarray(0, 10), mac)) throw new ErroDeMidia(NAO_CONFERE);
  let plano: Buffer;
  try {
    const d = createDecipheriv("aes-256-cbc", cipherKey, iv);
    plano = Buffer.concat([d.update(corpo), d.final()]);
  } catch {
    throw new ErroDeMidia(NAO_CONFERE);
  }
  if (hashes.sha256 && !igual(createHash("sha256").update(plano).digest(), Buffer.from(hashes.sha256, "base64"))) throw new ErroDeMidia(NAO_CONFERE);
  return plano;
}

// ---- nomes de arquivo (vêm de terceiros) ----

/** Extensões aceitas por tipo (a primeira é a que se põe quando falta). */
const EXTENSOES: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "video/mp4": ["mp4", "m4v"],
  "video/3gpp": ["3gp"],
  "video/quicktime": ["mov"],
  "audio/ogg": ["ogg", "opus", "oga"],
  "audio/mpeg": ["mp3"],
  "audio/mp4": ["m4a", "mp4"],
  "audio/aac": ["aac"],
  "audio/amr": ["amr"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt", "text", "log"],
  "text/csv": ["csv"],
  "application/json": ["json"],
  "text/markdown": ["md", "markdown"],
  "text/x-markdown": ["md", "markdown"],
  "application/zip": ["zip"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
};
/** Extensões que executam ao abrir: ganham ".bin" no fim (o arquivo continua lá, mas não abre sozinho com dois cliques). */
const EXECUTAVEIS = new Set(["exe", "com", "bat", "cmd", "scr", "pif", "msi", "msp", "js", "jse", "vbs", "vbe", "wsf", "wsh", "ps1", "psm1", "lnk", "url", "hta", "cpl", "jar", "app", "command", "tool", "sh", "pkg", "dmg", "scpt", "reg", "inf"]);
const RESERVADOS_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAXIMO_DO_NOME = 100;

/** mimetype sem parâmetros e em minúsculas ("audio/ogg; codecs=opus" -> "audio/ogg"). */
export const mimeBase = (m: string | undefined): string => (m ?? "").split(";")[0]!.trim().toLowerCase();

/**
 * Nome seguro para um arquivo que veio de outra pessoa: só a parte final (nada de pasta nem ".."), sem caractere de
 * controle nem de formatação (como a inversão da direção do texto), sem os proibidos no Windows, até 100 caracteres
 * e com extensão coerente com o tipo. Vazio vira `padrao`.
 */
export function nomeSeguro(nome: string | undefined, mimetype: string | undefined, padrao: string): string {
  let n = (nome ?? "").split(/[/\\]/).pop() ?? "";
  n = n.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/[<>:"|?*]/g, "_").replace(/\s+/g, " ");
  n = n.replace(/\.{2,}/g, ".").replace(/^[\s.]+|[\s.]+$/g, "");
  if (n === "") n = padrao.replace(/[^\p{L}\p{N}_ -]/gu, "") || "arquivo";
  const ponto = n.lastIndexOf(".");
  let base = ponto > 0 ? n.slice(0, ponto) : n;
  let ext = ponto > 0 ? n.slice(ponto + 1) : "";
  if (RESERVADOS_WINDOWS.test(base)) base = `_${base}`;
  const aceitas = EXTENSOES[mimeBase(mimetype)];
  let sufixo = "";
  if (aceitas) {
    if (!aceitas.includes(ext.toLowerCase())) sufixo = aceitas[0]!;
  } else if (ext === "" || !/^[\p{L}\p{N}]{1,10}$/u.test(ext)) {
    sufixo = "bin";
  }
  if (EXECUTAVEIS.has((sufixo || ext).toLowerCase())) sufixo = "bin";
  // Corta pelo nome (em caracteres), guardando as extensões.
  const caudas = [ext, sufixo].filter(Boolean).map((e) => `.${e}`).join("");
  if (sufixo === "" ) {
    base = [...base].slice(0, MAXIMO_DO_NOME - [...caudas].length).join("");
    return `${base}${caudas}`;
  }
  const comExt = ext ? `${base}.${ext}` : base;
  return `${[...comExt].slice(0, MAXIMO_DO_NOME - sufixo.length - 1).join("")}.${sufixo}`;
}

// ---- envio de arquivo ----

export type TipoDeEnvio = "imagem" | "video" | "audio" | "nota_de_voz" | "documento";

const MIME_POR_EXTENSAO: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSOES).flatMap(([mime, exts]) => exts.map((e) => [e, mime] as const)).reverse(),
);
MIME_POR_EXTENSAO.mp4 = "video/mp4";
MIME_POR_EXTENSAO.wav = "audio/wav";

const extensaoDe = (caminho: string): string => {
  const nome = caminho.split(/[/\\]/).pop() ?? "";
  const i = nome.lastIndexOf(".");
  return i > 0 ? nome.slice(i + 1).toLowerCase() : "";
};

const comeca = (b: Buffer, assinatura: string, em = 0) => b.subarray(em, em + assinatura.length).toString("latin1") === assinatura;
const ehJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const ehPng = (b: Buffer) => comeca(b, "\x89PNG");
const ehWebp = (b: Buffer) => comeca(b, "RIFF") && comeca(b, "WEBP", 8);
const ehMp4 = (b: Buffer) => comeca(b, "ftyp", 4);
const ehOgg = (b: Buffer) => comeca(b, "OggS");
const ehOpus = (b: Buffer) => ehOgg(b) && b.subarray(0, 512).includes(Buffer.from("OpusHead"));
const ehMp3 = (b: Buffer) => comeca(b, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0);
const ehWav = (b: Buffer) => comeca(b, "RIFF") && comeca(b, "WAVE", 8);

/**
 * Como o arquivo vai: pelo conteúdo (os primeiros bytes) E pela extensão. Imagem só jpg, png e webp de verdade; vídeo
 * só mp4; áudio só ogg, mp3, m4a e wav; o resto (ou tudo, com `como_documento`) vai como documento. `voz` só com
 * OGG/Opus. O mimetype do documento sai da extensão.
 */
export function tipoParaEnviar(caminho: string, cabeca: Buffer, opcoes: { como_documento?: boolean; voz?: boolean }): { tipo: TipoDeEnvio; mimetype: string } {
  const ext = extensaoDe(caminho);
  if (opcoes.voz) {
    if (!ehOpus(cabeca)) throw new Error("Mensagem de voz só com arquivo OGG/Opus (como as do próprio WhatsApp). Envie sem `voz`, como áudio ou documento. Nada foi preparado.");
    return { tipo: "nota_de_voz", mimetype: "audio/ogg; codecs=opus" };
  }
  const doc = { tipo: "documento" as const, mimetype: MIME_POR_EXTENSAO[ext] ?? "application/octet-stream" };
  if (opcoes.como_documento) return doc;
  if ((ext === "jpg" || ext === "jpeg") && ehJpeg(cabeca)) return { tipo: "imagem", mimetype: "image/jpeg" };
  if (ext === "png" && ehPng(cabeca)) return { tipo: "imagem", mimetype: "image/png" };
  if (ext === "webp" && ehWebp(cabeca)) return { tipo: "imagem", mimetype: "image/webp" };
  if (ext === "mp4" && ehMp4(cabeca)) return { tipo: "video", mimetype: "video/mp4" };
  if ((ext === "ogg" || ext === "opus") && ehOgg(cabeca)) return { tipo: "audio", mimetype: "audio/ogg" };
  if (ext === "mp3" && ehMp3(cabeca)) return { tipo: "audio", mimetype: "audio/mpeg" };
  if (ext === "m4a" && ehMp4(cabeca)) return { tipo: "audio", mimetype: "audio/mp4" };
  if (ext === "wav" && ehWav(cabeca)) return { tipo: "audio", mimetype: "audio/wav" };
  return doc;
}

/**
 * Nomes de arquivo de segredo, em qualquer lugar (inclusive dentro das pastas permitidas): .env, chaves privadas e
 * certificados, credenciais de git, npm, pip e do gh, a configuração do Claude Code e, desde a 0.16.0, os arquivos de
 * perfil de navegador (cookies, senhas salvas, a chave das senhas do Firefox).
 */
const NOMES_DE_SEGREDO =
  /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?|.*\.(pem|key|p12|pfx|ppk|keychain|keychain-db|kdbx|asc|gpg)|\.netrc|_netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials|\.claude\.json|credentials|known_hosts|authorized_keys|cookies(-journal)?|cookies\.sqlite|cookies\.binarycookies|login data( for account)?(-journal)?|web data|logins\.json|key[34]\.db|signons\.sqlite)$/i;
/** Pastas de segredo em qualquer lugar do caminho. */
const PASTAS_DE_SEGREDO = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", "keychains"]);

/** 0.16.0: as pastas do usuário de onde o wa_enviar_arquivo envia (e as subpastas delas). */
const PASTAS_PERMITIDAS = ["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Videos", "Music"] as const;
/** No Windows, as mesmas pastas quando o OneDrive as guarda (Documentos, Área de Trabalho e Imagens são as que ele move). */
const PASTAS_PERMITIDAS_NO_ONEDRIVE = ["Documents", "Desktop", "Pictures"] as const;

/** A frase da recusa fora das pastas permitidas: diz de onde pode enviar e o que o dono pode fazer, sem o caminho. */
export const FORA_DAS_PASTAS_PERMITIDAS =
  "Só envio arquivos que estão nas pastas Documentos, Mesa (Desktop), Downloads, Imagens, Filmes ou Vídeos e Músicas do dono (ou nas subpastas delas), " +
  "e este está fora delas. Se for para enviar mesmo, o dono pode copiar o arquivo para uma dessas pastas e pedir de novo.";

/**
 * 0.16.0: as pastas permitidas para envio, dentro da casa (Mac e Linux: Documents, Desktop, Downloads, Pictures, Movies,
 * Videos, Music; Windows: as mesmas no perfil do usuário e as do OneDrive). Pura: plataforma e casa injetáveis. A
 * Downloads/WhatsApp Claude (onde o wa_abrir_midia grava) fica dentro da Downloads.
 */
export function pastasPermitidasParaEnviar(plataforma: NodeJS.Platform, casa: string): string[] {
  if (plataforma === "win32") {
    return [...PASTAS_PERMITIDAS.map((n) => win32.join(casa, n)), ...PASTAS_PERMITIDAS_NO_ONEDRIVE.map((n) => win32.join(casa, "OneDrive", n))];
  }
  return PASTAS_PERMITIDAS.map((n) => posix.join(casa, n));
}

/**
 * Por que este caminho (REAL, já sem links) não pode ser enviado, ou undefined. Desde a 0.16.0 é lista de PERMISSÃO:
 * 1. as pastas `protegidas` (a de dados e a de registros da extensão) recusam sempre;
 * 2. fora das `permitidas` (padrão: `pastasPermitidasParaEnviar` da casa; quem chama passa também o caminho real delas,
 *    ex.: /var -> /private/var ou a Documentos guardada no iCloud), recusa. O caminho é normalizado antes (`..` some);
 * 3. dentro delas: pasta oculta (nome começando com ponto) em qualquer nível abaixo da pasta permitida, pasta de segredo,
 *    `hosts.yml` dentro de uma pasta `gh` e nome de arquivo de segredo recusam.
 * As frases nunca repetem o caminho. O cartão continua sendo a barreira principal; isto é a de antes dele.
 */
export function caminhoProibido(
  real: string,
  opcoes: { casa: string; plataforma: NodeJS.Platform; protegidas: readonly string[]; permitidas?: readonly string[] },
): string | undefined {
  const windows = opcoes.plataforma === "win32";
  const p = windows ? win32 : posix;
  const norm = (c: string) => {
    const n = p.normalize(c);
    return windows || opcoes.plataforma === "darwin" ? n.toLowerCase() : n;
  };
  const alvo = norm(real);
  const baseDe = (pasta: string) => norm(pasta).replace(/[\\/]+$/, "");
  const dentro = (pasta: string) => {
    const base = baseDe(pasta);
    return alvo === base || alvo.startsWith(base + p.sep);
  };
  for (const pasta of opcoes.protegidas) if (dentro(pasta)) return "Esse arquivo está na pasta de dados da extensão: não envio nada de lá.";
  // A pasta permitida mais funda que contém o arquivo; o que vem abaixo dela é o que se confere.
  const raiz = (opcoes.permitidas ?? pastasPermitidasParaEnviar(opcoes.plataforma, opcoes.casa))
    .map(baseDe)
    .filter((base) => alvo.startsWith(base + p.sep))
    .sort((a, b) => b.length - a.length)[0];
  if (raiz === undefined) return FORA_DAS_PASTAS_PERMITIDAS;
  const abaixo = alvo.slice(raiz.length + 1).split(/[\\/]/).filter(Boolean);
  const pastas = abaixo.slice(0, -1);
  const nome = abaixo.at(-1) ?? "";
  if (pastas.some((x) => PASTAS_DE_SEGREDO.has(x))) return "Esse arquivo está numa pasta de segredos (.ssh, .gnupg, .aws, chaveiros...): não envio nada de lá.";
  if (pastas.some((x) => x.startsWith("."))) {
    return "Esse arquivo está dentro de uma pasta oculta (nome começando com ponto): não envio nada de lá. Se for para enviar mesmo, o dono pode copiar o arquivo para uma pasta comum, como Documentos.";
  }
  if (NOMES_DE_SEGREDO.test(nome) || (nome.toLowerCase() === "hosts.yml" && pastas.at(-1)?.toLowerCase() === "gh")) {
    return "Esse arquivo parece um segredo (.env, chave privada, certificado, senha ou cookie de navegador, credencial): não envio. Se for mesmo para enviar, renomeie ou compacte antes.";
  }
  return undefined;
}

// ---- nome do arquivo aberto (0.16.0) ----

/**
 * 0.16.0: o nome com que o wa_abrir_midia grava o arquivo baixado, NEUTRO: `whatsapp-<tipo>-<AAAAMMDD-HHMMSS>-<8 hex>.<ext>`.
 * A data é a da mensagem, no relógio deste computador; os 8 hex são o começo do SHA-256 do id da mensagem (o id vem de
 * fora: só entra assim); a extensão sai do mimetype pela tabela fixa (EXTENSOES) e, desconhecido, vira `bin`. O nome
 * que a outra pessoa deu nunca entra (fica só em conteudo_de_terceiros).
 */
export function nomeNeutroDeMidia(tipo: string, ts: number, id: string, mimetype: string | undefined): string {
  const d = new Date(ts);
  const dois = (n: number) => String(n).padStart(2, "0");
  const data = `${d.getFullYear()}${dois(d.getMonth() + 1)}${dois(d.getDate())}-${dois(d.getHours())}${dois(d.getMinutes())}${dois(d.getSeconds())}`;
  const hex = createHash("sha256").update(id).digest("hex").slice(0, 8);
  const ext = EXTENSOES[mimeBase(mimetype)]?.[0] ?? "bin";
  const rotulo = tipo.replace(/[^a-z_]/g, "") || "midia";
  return `whatsapp-${rotulo}-${data}-${hex}.${ext}`;
}

/** Tamanho legível ("12 KB", "3,4 MB"). */
export function tamanhoLegivel(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
