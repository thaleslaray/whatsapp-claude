// 0.16.0, item 1 da revisão de segurança: o wa_enviar_arquivo passa de lista de bloqueio para lista de PERMISSÃO.
// Só sai arquivo de dentro de Documentos, Mesa (Desktop), Downloads, Imagens, Filmes/Vídeos e Músicas do dono (e
// subpastas), conferido pelo caminho REAL (link simbólico para fora e `..` não valem). Fora delas, recusa com a frase que
// diz de onde pode enviar. Dentro delas, a lista de segredos continua (e cresceu: perfis de navegador, .git-credentials,
// hosts.yml do gh, .claude.json...), e pasta oculta em qualquer nível recusa. A frase nunca repete o caminho.
// A função pura é testada com separador do Mac e do Windows; a ferramenta, com socket falso e a casa na pasta temporária.

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { caminhoProibido, pastasPermitidasParaEnviar } from "../src/midia.ts";
import { ANA, assentar, chamarCru, conectar, conectarCliente, ligarEnvio, montar, pn, textoDe, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const MAC = { casa: "/Users/f", plataforma: "darwin" as const, protegidas: [] };
const WIN = { casa: "C:\\Users\\F", plataforma: "win32" as const, protegidas: [] };
const FORA = /Documentos.*Downloads.*copiar/s;

describe("0.16.0: lista de permissão do envio de arquivo (função pura)", () => {
  it("as pastas permitidas no Mac e no Windows (Documentos, Mesa, Downloads, Imagens, Filmes/Vídeos, Músicas)", () => {
    const mac = pastasPermitidasParaEnviar("darwin", "/Users/f");
    for (const n of ["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Videos", "Music"]) assert.ok(mac.includes(`/Users/f/${n}`), n);
    const win = pastasPermitidasParaEnviar("win32", "C:\\Users\\F");
    for (const n of ["Documents", "Desktop", "Downloads", "Pictures", "Videos", "Music"]) assert.ok(win.includes(`C:\\Users\\F\\${n}`), n);
  });

  it("cada pasta permitida, a subpasta e a Downloads/WhatsApp Claude da extensão passam", () => {
    for (const n of ["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Videos", "Music"]) {
      assert.equal(caminhoProibido(`/Users/f/${n}/arquivo.pdf`, MAC), undefined, n);
      assert.equal(caminhoProibido(`/Users/f/${n}/sub/pasta/arquivo.pdf`, MAC), undefined, `${n}/sub`);
    }
    assert.equal(caminhoProibido("/Users/f/Downloads/WhatsApp Claude/whatsapp-imagem.jpg", MAC), undefined);
    assert.equal(caminhoProibido("/USERS/F/documents/Contrato.PDF", MAC), undefined, "no Mac, sem diferença de maiúsculas");
    for (const n of ["Documents", "Desktop", "Downloads", "Pictures", "Videos", "Music"]) {
      assert.equal(caminhoProibido(`C:\\Users\\F\\${n}\\sub\\arquivo.pdf`, WIN), undefined, `Windows ${n}`);
    }
  });

  it("fora das pastas permitidas: recusa com a frase de onde pode enviar e sem repetir o caminho", () => {
    for (const p of ["/Users/f/arquivo.pdf", "/Users/f/projeto/relatorio.pdf", "/tmp/a.pdf", "/Users/outro/Documents/a.pdf", "/Users/f/DocumentsFalsa/a.pdf"]) {
      const r = caminhoProibido(p, MAC);
      assert.match(r ?? "", FORA, p);
      assert.ok(!r!.includes("/Users/f"), "a frase não repete o caminho");
    }
    assert.match(caminhoProibido("C:\\Users\\F\\projeto\\a.pdf", WIN) ?? "", FORA);
  });

  it("`..` não vale: o caminho é normalizado antes de conferir", () => {
    assert.match(caminhoProibido("/Users/f/Documents/../.ssh/id_ed25519", MAC) ?? "", /./);
    assert.match(caminhoProibido("/Users/f/Documents/../segredo.pdf", MAC) ?? "", FORA);
    assert.match(caminhoProibido("C:\\Users\\F\\Documents\\..\\AppData\\x.pdf", WIN) ?? "", FORA);
  });

  it("perfis de navegador, Mensagens, cookies, ~/.claude.json, ~/.claude/ e ~/.config/gh/hosts.yml: recusados (Mac)", () => {
    for (const p of [
      "/Users/f/Library/Application Support/Google/Chrome/Default/Cookies",
      "/Users/f/Library/Application Support/Google/Chrome/Default/Login Data",
      "/Users/f/Library/Application Support/Firefox/Profiles/x.default/logins.json",
      "/Users/f/Library/Safari/History.db",
      "/Users/f/Library/Messages/chat.db",
      "/Users/f/Library/Cookies/Cookies.binarycookies",
      "/Users/f/.claude.json",
      "/Users/f/.claude/settings.json",
      "/Users/f/.config/gh/hosts.yml",
      "/Users/f/.git-credentials",
    ]) {
      assert.ok(caminhoProibido(p, MAC), p);
    }
  });

  it("perfis de navegador no Windows (Chrome, Edge, Firefox em AppData\\Local e Roaming): recusados", () => {
    for (const p of [
      "C:\\Users\\F\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies",
      "C:\\Users\\F\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Login Data",
      "C:\\Users\\F\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x.default\\key4.db",
      "C:\\Users\\F\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\x\\cache2\\a",
    ]) {
      assert.ok(caminhoProibido(p, WIN), p);
    }
  });

  it("dentro de pasta permitida, a lista de segredos continua e ganhou itens novos", () => {
    for (const nome of [
      ".env",
      ".env.local",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
      "id_ed25519_sk",
      "servidor.pem",
      "privada.key",
      "certificado.p12",
      "certificado.pfx",
      "senhas.kdbx",
      "Cookies",
      "Login Data",
      "logins.json",
      "key4.db",
      "cookies.sqlite",
      ".git-credentials",
      ".netrc",
      ".claude.json",
    ]) {
      assert.ok(caminhoProibido(`/Users/f/Documents/${nome}`, MAC), nome);
      assert.ok(caminhoProibido(`C:\\Users\\F\\Downloads\\${nome}`, WIN), `Windows ${nome}`);
    }
    assert.ok(caminhoProibido("/Users/f/Documents/backup/gh/hosts.yml", MAC), "hosts.yml dentro de pasta gh");
    assert.equal(caminhoProibido("/Users/f/Documents/ansible/hosts.yml", MAC), undefined, "hosts.yml fora de pasta gh é arquivo comum");
  });

  it("pasta oculta em qualquer nível, mesmo dentro de pasta permitida: recusa", () => {
    for (const p of ["/Users/f/Documents/.segredos/a.pdf", "/Users/f/Downloads/projeto/.git/config", "/Users/f/Desktop/a/b/.cache/foto.jpg"]) {
      assert.match(caminhoProibido(p, MAC) ?? "", /oculta/, p);
    }
    assert.match(caminhoProibido("C:\\Users\\F\\Documents\\.config\\a.txt", WIN) ?? "", /oculta/);
  });

  it("a pasta de dados da extensão continua recusada, mesmo se estiver dentro de uma pasta permitida", () => {
    const o = { ...MAC, protegidas: ["/Users/f/Documents/dados-wa"] };
    assert.match(caminhoProibido("/Users/f/Documents/dados-wa/indice.enc", o) ?? "", /pasta de dados/);
  });

  it("a casa por trás de um link (como /var -> /private/var): as pastas permitidas passadas já resolvidas valem", () => {
    const o = { ...MAC, permitidas: ["/private/casa/Documents"] };
    assert.equal(caminhoProibido("/private/casa/Documents/a.pdf", o), undefined);
    assert.match(caminhoProibido("/Users/f/Documents/a.pdf", o) ?? "", FORA, "só as passadas valem");
  });
});

// ---- a ferramenta, com a casa na pasta temporária ----

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

async function cenario() {
  m = await montar();
  const s = await conectar(m);
  await assentar(m);
  s.mensagens([msg({ jid: pn(ANA), id: "T1", texto: "oi", nome: "Ana" })]);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  await ligarEnvio(cliente);
  return { c: cliente, m };
}

function arquivo(base: string, ...partes: string[]): string {
  const p = join(base, ...partes);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "%PDF-1.4 conteudo");
  return p;
}

describe("0.16.0: wa_enviar_arquivo com a lista de permissão", () => {
  it("arquivo em Documentos (e subpasta) mostra o cartão; fora das pastas, recusa sem cartão e sem o caminho na frase", async () => {
    const { c, m } = await cenario();
    for (const p of [arquivo(m.dir, "Documents", "a.pdf"), arquivo(m.dir, "Pictures", "viagem", "2026", "b.pdf"), arquivo(m.dir, "Downloads", "WhatsApp Claude", "c.pdf")]) {
      const r = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: p });
      assert.equal(r.isError, undefined, textoDe(r));
      assert.equal(typeof r.structuredContent!.pedido, "string");
    }
    const fora = arquivo(m.dir, "projeto", "relatorio.pdf");
    const r = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: fora });
    assert.equal(r.isError, true);
    assert.match(textoDe(r), FORA);
    assert.ok(!textoDe(r).includes(m.dir) && !textoDe(r).includes("relatorio"), "a frase não repete o caminho");
    assert.equal(r._meta, undefined, "sem prévia");
  });

  it("link simbólico em Documentos que aponta para fora não vale; link de fora que aponta para dentro vale (vale o real)", async () => {
    const { c, m } = await cenario();
    const fora = arquivo(m.dir, "segredos", "x.pdf");
    mkdirSync(join(m.dir, "Documents"), { recursive: true });
    const atalho = join(m.dir, "Documents", "atalho.pdf");
    symlinkSync(fora, atalho);
    const r = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: atalho });
    assert.equal(r.isError, true);
    assert.match(textoDe(r), FORA);
    const dentro = arquivo(m.dir, "Documents", "ok.pdf");
    const atalhoDeFora = join(m.dir, "atalho-de-fora.pdf");
    symlinkSync(dentro, atalhoDeFora);
    const ok = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: atalhoDeFora });
    assert.equal(ok.isError, undefined, textoDe(ok));
    // Subpasta de Documentos que é um link para fora (ex.: para a .ssh): vale o real, que fica fora.
    arquivo(m.dir, "chaves", "z.pdf");
    symlinkSync(join(m.dir, "chaves"), join(m.dir, "Documents", "chaves"));
    const pelaSubpasta = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: join(m.dir, "Documents", "chaves", "z.pdf") });
    assert.equal(pelaSubpasta.isError, true);
    assert.match(textoDe(pelaSubpasta), FORA);
  });

  it("`..` no caminho pedido não escapa de Documentos", async () => {
    const { c, m } = await cenario();
    arquivo(m.dir, "fora.pdf");
    mkdirSync(join(m.dir, "Documents"), { recursive: true });
    const r = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: `${join(m.dir, "Documents")}/../fora.pdf` });
    assert.equal(r.isError, true);
    assert.match(textoDe(r), FORA);
  });

  it("dentro de Documentos: .env, chave, Cookies, .git-credentials e pasta oculta continuam recusados", async () => {
    const { c, m } = await cenario();
    for (const p of [
      arquivo(m.dir, "Documents", ".env"),
      arquivo(m.dir, "Documents", "id_ed25519"),
      arquivo(m.dir, "Documents", "Cookies"),
      arquivo(m.dir, "Documents", ".git-credentials"),
      arquivo(m.dir, "Documents", ".claude.json"),
      arquivo(m.dir, "Documents", "gh", "hosts.yml"),
      arquivo(m.dir, "Documents", ".oculta", "a.pdf"),
    ]) {
      const r = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: p });
      assert.equal(r.isError, true, p);
      assert.ok(!textoDe(r).includes(m.dir), "sem o caminho");
    }
  });

  it("a recusa não deixa o caminho nem o nome do arquivo no registro de ações nem na caixa-preta", async () => {
    const { c, m } = await cenario();
    const fora = arquivo(m.dir, "projeto-sigiloso", "relatorio-sigiloso.pdf");
    await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: fora });
    const textos: string[] = [];
    const ler = (q: string): void => {
      if (!existsSync(q)) return;
      for (const n of readdirSync(q)) {
        const f = join(q, n);
        if (statSync(f).isDirectory()) ler(f);
        else textos.push(readFileSync(f, "utf8"));
      }
    };
    ler(m.config.dirLogs);
    for (const t of textos) assert.ok(!t.includes("sigiloso"), "nada do caminho nos registros");
  });

  it("a descrição da ferramenta diz de quais pastas envia", async () => {
    const { c } = await cenario();
    const f = (await c.listTools()).tools.find((t) => t.name === "wa_enviar_arquivo")!;
    assert.match(f.description ?? "", /Documentos/);
    assert.match(f.description ?? "", /Downloads/);
  });
});
