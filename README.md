# WhatsApp + Claude

**Seu Claude lendo o seu WhatsApp: conversas, grupos que você escolher, áudios e arquivos.** Nada é enviado, editado ou apagado sem o seu clique.

[![Licença MIT](https://img.shields.io/github/license/thaleslaray/whatsapp-claude)](LICENSE)
[![Versão](https://img.shields.io/github/v/release/thaleslaray/whatsapp-claude)](https://github.com/thaleslaray/whatsapp-claude/releases/latest)
[![Testado no macOS](https://img.shields.io/badge/testado%20no-macOS-lightgrey)](#compatibilidade)

Conecta como **aparelho vinculado**, pela biblioteca Baileys. Tudo fica cifrado no seu computador, com a chave no cofre do sistema. Funciona no **Mac** e no **Windows**.

## Aviso de risco

> **Este é um cliente não oficial. Ele viola os termos do WhatsApp e pode levar à restrição ou ao banimento do seu número.** Use por sua conta e risco. Não tem relação com o WhatsApp nem com a Meta.
>
> **Começar conversa com quem não tem o seu número é o que mais leva a banimento.** Por isso há um teto baixo de conversas novas por dia (padrão 5; 0 desliga).

- A conexão só fica ligada com o Claude Desktop aberto.
- Tudo fica cifrado neste computador, com a chave guardada no cofre do sistema (veja [Onde fica a chave](#onde-fica-a-chave)).
- Nunca marca mensagem como lida, nunca aparece online e não manda prévia de link.
- As fotos, áudios, vídeos e documentos que você pedir para abrir ficam **sem cifra** em `Downloads/WhatsApp Claude`.

## Instalar com um prompt

Abra o **Claude Desktop** na aba **Code** (ou o Claude Code no terminal), cole o texto abaixo e envie:

```text
Instale o WhatsApp + Claude seguindo o guia
https://raw.githubusercontent.com/thaleslaray/whatsapp-claude/main/INSTALL.md
Leia o guia inteiro antes de rodar qualquer comando, me diga o que vai fazer
e pare para eu decidir antes de parear o WhatsApp.
```

O Claude baixa a extensão e confere se o arquivo é o original. Depois instala a skill de rotinas. Ele não pareia por você: o QR do WhatsApp é seu.

Depois disso, abra o arquivo `whatsapp-pessoal.mcpb` que ficou em Downloads, confirme a instalação e siga [Parear](#parear).

> Prefere fazer à mão? Veja [Instalação manual](#instalação-manual).

## O que vem no pacote

| Parte | O que é | O que faz |
|---|---|---|
| **Extensão do WhatsApp** ([`mcp/`](mcp/)) | Um servidor MCP empacotado como extensão `.mcpb` do Claude Desktop. MCP é a ponte que deixa o Claude usar um programa. | Dá ao Claude 34 ferramentas para ler e, com o seu clique, escrever no **seu** WhatsApp. Funciona no chat e na aba Code. |
| **Skill de rotinas** ([`skill/rotinas-whatsapp`](skill/rotinas-whatsapp/)) | Um conjunto de rotinas que o Claude segue com você. O pacote para instalar é [`skill/rotinas-whatsapp.skill`](skill/rotinas-whatsapp.skill). | Quem espera resposta, escolha rápida entre respostas prontas, perguntas sem resposta num grupo, pauta e frases de um grupo, promessas, resumo dos grupos que você acompanha e monitor dos grupos da equipe por setor. Nenhuma rotina envia nada sozinha. |

## Tudo que dá para fazer

Depois de instalado, é só conversar com o Claude do seu jeito. Não precisa saber o nome das ferramentas: as frases abaixo são exemplos. Nas tabelas, a coluna **Seu clique** diz o que acontece antes da ação ir para o WhatsApp:
- **Sim:** a ação só vai depois que você clica no cartão de prévia.
- **Direto:** vale na hora e fica registrada.
- **Leitura:** só lê, não muda nada fora do seu computador.

### Parear e controlar o envio

| Peça assim | O que o Claude faz | Seu clique |
|---|---|---|
| "Está conectado?" / "Quantas conversas estão guardadas?" | Mostra conexão, número, conversas guardadas e o limite do dia | Leitura |
| "Parear o WhatsApp" | Mostra o aviso de risco e, depois, o QR para ler com o celular | Sim |
| "Ligar o envio" / "Desligar o envio" | O envio começa desligado. Liga e desliga | Sim |
| "Desconectar o WhatsApp" | Tira o aparelho e apaga tudo deste computador | Sim |

### Ler e achar

| Peça assim | O que o Claude faz | Seu clique |
|---|---|---|
| "Quem me escreveu hoje? Quem espera resposta?" | Lista as conversas, diz quais terminam em mensagem de outra pessoa e dá uma pista quando ela só fechou o assunto | Leitura |
| "O que a Ana me falou ontem?" | Lê as mensagens guardadas de uma conversa | Leitura |
| "Procura onde falaram do aluguel" | Busca por palavras, sem acento, também nas transcrições de áudio e nos nomes de arquivo | Leitura |
| "Lista meus grupos" | Mostra só o nome e o tamanho de cada grupo | Leitura |
| "Busca mensagens mais antigas da conversa com o Beto" | Pede ao celular mensagens anteriores às guardadas, até 50 por vez | Leitura |
| "Atualiza meus contatos" | Pede de novo ao celular a agenda, quando faltar nome | Leitura |

### Fotos, áudios, vídeos e documentos

| Peça assim | O que o Claude faz | Seu clique |
|---|---|---|
| "Mostra a foto que a Ana mandou" / "Abre o PDF do grupo" | Baixa e decifra a mídia recebida. Foto pequena aparece para o Claude ver; o resto fica em `Downloads/WhatsApp Claude` | Direto |
| "Transcreve o áudio da Ana" | Transcreve **neste computador**, sem mandar o áudio para serviço nenhum. Na primeira vez, pede o clique para baixar o modelo (190 MB) | Sim, só para baixar o modelo |

### Responder e enviar

| Peça assim | O que o Claude faz | Seu clique |
|---|---|---|
| "Responde a Ana que eu chego às 15h" | Prévia com o texto, que dá para editar. Em grupo, o cartão mostra quantas pessoas vão receber | Sim |
| "Responde o Leonardo, minha mãe e a Jhenifer de uma vez" | Um cartão só com várias conversas: dá para editar cada mensagem e desmarcar quem não deve receber. Um clique em "Enviar todas" | Sim |
| "Manda este PDF para o Beto" | Envia foto, vídeo, áudio, mensagem de voz (OGG/Opus), figurinha (WebP de 512x512, até 100 KB parada ou 500 KB animada, sem legenda) ou documento do computador, com legenda editável | Sim |
| "Começa uma conversa com +55 11 91234-5678" | Primeira mensagem para um número novo. O cartão mostra o número inteiro. Conta no limite do dia e no teto de conversas novas | Sim |
| "Corrige aquela mensagem" | Edita uma mensagem de texto sua, até 15 min depois | Sim |
| "Apaga aquela mensagem para todos" | Apaga para todos uma mensagem sua, até 48 h depois. Não tem volta | Sim |
| "Reage com um joinha" / "Tira a reação" | Reage com um emoji, com teto de reações por dia | Direto |

### Escolher o que o Claude lê

| Peça assim | O que o Claude faz | Seu clique |
|---|---|---|
| "Lê o grupo da família" | Inclui um grupo. Nenhum grupo é lido até você escolher | Sim |
| "Para de ler o grupo da família" | Tira o grupo e apaga o que estava guardado dele | Direto |
| "Nunca leia a conversa com o Beto" | Põe na lista "nunca ler" e apaga o que estava guardado dela | Direto |
| "Pode voltar a ler a conversa com o Beto" | Tira da lista "nunca ler" | Sim |

Tudo o que faz o Claude ler **mais** pede o seu clique; tudo o que faz ler **menos** vale na hora.

### Memória e seu jeito de escrever

| Peça assim | O que o Claude faz | Seu clique |
|---|---|---|
| "Anota o que ficou combinado com a Carla" | Guarda, cifrado neste computador, um resumo por conversa e os compromissos (promessa, pedido ou pergunta, com a frase exata e o prazo) | Direto |
| "O que ficou em aberto?" | Lê a memória: resumos e compromissos, com prazo | Leitura |
| "Esquece o que você anotou do Beto" | Apaga a memória de uma conversa ou toda | Direto |
| "Resume o grupo desde a última vez" | Guarda até onde o grupo já foi resumido, para o próximo resumo começar dali | Direto |
| "Como eu costumo escrever?" | Mostra o seu jeito, medido nas suas mensagens: tamanho, rajadas, minúsculas, pontuação, emoji | Leitura |
| "Como eu respondi dúvidas parecidas?" | Mostra o que você já respondeu antes, com a data | Leitura |
| "O que você aprendeu comigo?" | Mostra as regras propostas a partir do que você muda nos cartões | Leitura |
| "Adota essa regra" / "Para de aprender" | Decide as regras, dá o tipo das conversas (cliente, família, equipe), liga e desliga o aprendizado | Direto |

O Claude também confere cada rascunho contra o seu jeito antes de abrir o cartão.

### Roteiros prontos

São duas tarefas completas, que o servidor oferece como atalhos (os "prompts" do MCP). Não precisa achar o atalho: dá para pedir com as suas palavras.

| Roteiro | O que faz |
|---|---|
| Caixa do dia | Quem escreveu nas últimas 24 h, quem está esperando resposta e há quanto tempo |
| Resumo dos grupos | O que rolou nos grupos escolhidos desde o último resumo, guardando a marca da última leitura |

A skill [`rotinas-whatsapp`](skill/rotinas-whatsapp/) traz rotinas maiores por cima dessas ferramentas: pendências, passada de escolha rápida, perguntas e conteúdo de grupo, promessas, resumo dos grupos que você acompanha e monitor dos grupos da equipe. As listas reais de grupos e pessoas ficam na sua pasta `~/Documents/WhatsApp Claude/rotinas/`, nunca no repositório.

### O cartão de prévia

Toda ação marcada com "Sim" abre um cartão na conversa antes de ir para o WhatsApp. O cartão mostra exatamente o que vai sair, deixa você corrigir o texto ali mesmo e tem os botões de confirmar e cancelar. O pareamento só começa com o seu clique no aviso de risco.

## Parear

### Numa conversa comum

1. Peça ao Claude: **"parear o WhatsApp"**.
2. No cartão, leia o aviso e clique em **"Entendo o risco, mostrar o QR"**.
3. No celular, abra **WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho** e leia o QR do cartão. O QR muda sozinho a cada 60 s.
4. O cartão mostra "Conectado como +55 …".

### Na aba Code

Lá o cartão não consegue falar direto com a extensão, então ele conversa pelo chat:

1. Peça **"parear o WhatsApp"** e clique em **"Entendo o risco, mostrar o QR"**. O cartão manda no chat uma mensagem com um código que só ele conhece.
2. O Claude confirma, e um **cartão novo com o QR** aparece logo abaixo. Leia com o celular como acima.
3. Se o QR vencer (60 s), clique em **"Mostrar novo QR"**: aparece outro cartão. Depois de ler, clique em **"Já escaneei"** e o Claude confere se conectou.

O Claude nunca vê o QR: ele vai só para o cartão.

A conversa comum e a aba Code funcionam ao mesmo tempo: dá para ler, parear e responder de qualquer uma das duas.

## Limites e detalhes

### Escolher o que o Claude lê

- **Conversas individuais:** todas, menos as da lista "nunca ler". Pôr na lista vale na hora e apaga o que estava guardado dela. Tirar da lista mostra um cartão e só vale com o seu clique.
- **Grupos:** nenhum, até você escolher. O cartão mostra o grupo e só vale com o seu clique. Tirar um grupo vale na hora e apaga o que estava guardado dele.

### Escrever

- O envio começa **desligado**. Peça "ligar o envio" e clique no cartão.
- **Limites por dia:** respostas e conversas novas somadas (padrão 30, de 1 a 200); conversas novas (padrão 5, de 0 a 20; 0 desliga); reações; pedidos de histórico (padrão 30, de 1 a 500); mídias abertas (100). Os dois primeiros e o de histórico mudam nos campos da extensão.
- **Começar conversa:** número com DDI, por exemplo +55 11 9…. O cartão mostra o número inteiro para você conferir.
- **Editar:** só mensagem de texto sua, até 15 min depois. O cartão mostra o texto de agora e o novo.
- **Apagar para todos:** só mensagem sua, até 48 h depois. O cartão mostra o que vai sumir. Não tem volta.
- **Reagir:** vale na hora, sem cartão. Peça para tirar a reação e ela some.

### Enviar um arquivo

Para uma conversa que já existe ou um grupo escolhido: o cartão mostra o nome, o tipo, o tamanho e o caminho real do arquivo, e a legenda dá para editar.

- **Tetos:** 16 MB para foto, vídeo e áudio; 100 MB para documento.
- **Só sai arquivo que está** nas pastas Documentos, Mesa (Desktop), Downloads, Imagens, Filmes ou Vídeos e Músicas da sua pasta de usuário, e nas subpastas delas (no Windows, também as do OneDrive). Isso é conferido pelo caminho real: um atalho que aponta para fora não vale. Arquivo em outro lugar é recusado. Se for para enviar mesmo, copie o arquivo para uma dessas pastas e peça de novo.
- **A extensão recusa**, mesmo dentro dessas pastas: pasta oculta (nome começando com ponto), `.env`, chaves privadas e certificados (`.pem`, `.key`, `.p12`, `id_rsa`...), credenciais (`.git-credentials`, `.netrc`, `hosts.yml` do `gh`, `.claude.json`) e arquivos de navegador (cookies e senhas salvas). Nunca envia nada da pasta de dados dela.
- Foto (JPEG ou PNG) sai com miniatura, feita depois do seu clique, e o cartão mostra a foto se ela tiver até 1 MB. Vídeo sai sem miniatura, porque ela dependeria do `ffmpeg`, que a extensão não traz e não chama.

### Abrir fotos, áudios, vídeos e documentos

Foto pequena aparece para o Claude ver; o resto (e a foto também) fica em **`Downloads/WhatsApp Claude`**, na sua pasta de usuário (Mac e Windows), e o Claude diz o caminho. Documento de texto pequeno ele também lê.

- **Nome do arquivo:** neutro, como `whatsapp-documento-20261115-090807-3cbc07c9.pdf` (tipo, data e hora da mensagem, um pedaço do id dela e a extensão certa para o tipo). O nome que a outra pessoa deu ao arquivo não vira nome de arquivo no seu computador: o Claude o recebe à parte, marcado como texto de terceiros.
- **Esses arquivos ficam SEM cifra**, fora da pasta de dados da extensão, porque você pediu para abrir. O "desconectar" não os apaga: apague você, se quiser.
- Não abre mídia de visualização única nem acima de 50 MB. Mídia antiga que o servidor do WhatsApp já não tem é pedida de novo ao celular uma vez.
- No máximo 100 aberturas por dia (transcrever também conta).

### Transcrever áudios

O áudio é transcrito **neste computador**, pelo whisper.cpp que vai dentro da extensão: nenhum áudio sai daqui para um serviço de transcrição.

- **O modelo, na primeira vez.** O modelo de transcrição (`ggml-small-q5_1.bin`, 190 MB) não vai no pacote. Na primeira transcrição aparece um cartão: "Baixar o modelo de transcrição, 190 MB, de huggingface.co, uma vez só". O download só começa com o seu clique e roda por trás; peça a transcrição de novo para ver o progresso. Só vale endereço HTTPS do Hugging Face (huggingface.co e as CDNs dele, numa lista fechada), e o arquivo é conferido (sha256) no fim: se não conferir, é apagado e o cartão volta.
- **Onde fica:** na subpasta `modelos` da pasta de dados (veja [Onde ficam os dados](#onde-ficam-os-dados)), **sem cifra**, porque é um arquivo público, igual para todo mundo. O "desconectar" **não** o apaga; as transcrições guardadas com as mensagens, sim.
- **Como responde:** se termina em até uns 20 s, o texto vem na hora; se não, o Claude diz que está andando e pergunta de novo. Uma transcrição por vez. Áudio de até 30 min. O texto fica guardado, cifrado, junto com a mensagem, e aparece quando o Claude lê a conversa.
- **É automático:** pode ter erros, principalmente em nomes e números. O Claude corrige só o óbvio, marca o que ficou duvidoso e mostra o texto cru se você pedir.
- **Formato:** a mensagem de voz comum do WhatsApp (OGG/Opus) é transcrita. Outro formato (um áudio .m4a encaminhado, por exemplo) ainda não: o Claude devolve o arquivo em `Downloads/WhatsApp Claude` para você ouvir.
- **Idioma:** português por padrão. Dá para trocar no campo "Idioma da transcricao" da extensão: `pt`, `en`, `es` ou `auto` (o motor descobre).
- **Onde roda:** Mac com Apple Silicon usa a GPU e deixa o modelo carregado por 10 min depois do último uso; os outros usam no máximo 4 núcleos do processador. **Testado só no Mac com Apple Silicon.** Windows (x64 e ARM) e Mac Intel vão no pacote, mas NÃO foram testados. Se o motor não carregar no seu computador, a extensão não cai: o Claude diz que a transcrição não está disponível aqui, e por quê, e devolve o arquivo do áudio.

### Mensagens mais antigas

Para ver mensagens mais antigas que as guardadas, peça "busca mensagens mais antigas da conversa com o Beto": o pedido vai ao celular, que precisa estar ligado e com internet. No máximo 50 por vez, uma vez a cada 30 s por conversa, 30 por dia (o dia pode subir até 500 no campo da extensão; suba só de propósito, porque pedidos demais em pouco tempo podem chamar a atenção do WhatsApp).

### Buscar, triar e lembrar

- **Busca:** por palavras, sem diferença de acento ou maiúscula, por relevância, também nas transcrições de áudio e nos nomes de arquivo. Mensagens seguidas (até 15 minutos de silêncio entre elas) formam um bloco: a busca devolve um resultado por bloco e acha palavras que estão em mensagens vizinhas. O índice vive só na memória do programa; nada dele é gravado em disco.
- **Quem espera resposta:** a lista de conversas diz quais terminam em mensagem de outra pessoa e dá uma pista quando ela parece só ter fechado o assunto ("valeu", figurinha, emoji). É pista, não certeza.
- **Memória:** só se você pedir. O programa só grava um compromisso se a frase está mesmo na mensagem citada. Bloquear a conversa, tirar o grupo ou desconectar apagam a memória junto.
- **Seu jeito:** o programa mede sozinho como você escreve (tamanho, minúsculas, pontuação, emoji, como abre e fecha), só nas suas mensagens, e entrega ao Claude exemplos reais seus na hora de redigir. Ele também guarda o que você muda nos cartões; quando o mesmo ajuste aparece duas vezes, o Claude propõe uma regra e pergunta se pode adotar. "O que você aprendeu comigo?" mostra tudo; "para de aprender" desliga; "esquece o que aprendeu" apaga.
- **Em grupo**, quem escreveu aparece com o número mascarado quando o programa o conhece, e sempre com um rótulo estável (`p_...`), para dar para contar pessoas sem ver o número de ninguém.

## Segurança

- **Toda escrita passa pelo seu clique.** Responder, enviar arquivo, começar conversa, editar e apagar mostram um cartão de prévia, e a ação só acontece quando você clica. Na conversa comum e na aba Code, o Claude não consegue confirmar sozinho.
- **O código do chat vale só para o texto que você viu.** Quando o app não deixa o cartão falar direto com a extensão, o cartão manda no chat um código que só vale para o texto que você viu: o Claude não consegue trocar o texto. O código que vai para o cartão (o "de tela") é diferente do que vale pelo chat (o "de conversa", calculado pelo cartão só na hora do seu clique): mesmo que um app mostrasse ao Claude o que vai para o cartão, aquele código não confirma nada pela conversa.
- **Mensagem de terceiro é dado, não ordem.** Texto que chega de outras pessoas (mensagens, nomes, nomes de grupo, nomes de arquivo e o que está escrito dentro de uma foto) é tratado como dado. Se uma mensagem disser "ignore as instruções", o Claude não obedece. Ampliar o que o Claude lê (escolher grupo, tirar alguém da lista "nunca ler") só acontece com o seu clique.
- **O pareamento só começa com o clique no aviso de risco.**
- **Tudo fica registrado.** Cada ação entra num registro local de ações (veja [Onde ficam os dados](#onde-ficam-os-dados)).
- **O que a proteção cobre, nos dois sistemas:** disco roubado, a cópia da pasta de dados (um backup levado para outro computador não abre) e outro usuário do mesmo computador.
- **O que ela não cobre:** outro programa rodando na sua própria conta. No Mac, um terminal lê o item do Keychain com `security find-generic-password` sem pedir senha. No Windows, qualquer programa da sua conta pode pedir à DPAPI para abrir o arquivo. Com a chave, dá para decifrar a sessão do WhatsApp e as mensagens guardadas. **Por isso, não dê permissão ampla de terminal (shell) ao Claude Code, ou à aba Code, no mesmo computador em que esta extensão está ligada.** A aba Code continua permitida; só não libere o terminal de forma ampla.
- **Canal entre as sessões:** o Claude Desktop abre uma cópia da extensão para cada lugar (conversa comum, aba Code). Só uma fica com a conexão do WhatsApp; as outras pedem a ela por um canal local (um arquivo especial na pasta de dados no Mac, um "pipe" com nome aleatório no Windows), nunca pela rede. Antes de qualquer pedido, os dois lados provam que conhecem a chave deste computador, e quem recebe só executa as ferramentas da própria extensão, com as mesmas regras de clique.

Achou uma falha de segurança? Veja [SECURITY.md](SECURITY.md).

## Compatibilidade

| | |
|---|---|
| Sistema | **Mac e Windows.** O mesmo pacote serve para os dois. Testado no macOS. A transcrição de áudio, só no Mac com Apple Silicon. |
| Claude | Claude Desktop, para a extensão. Aba Code do Claude Desktop ou Claude Code no terminal, para a skill. |
| WhatsApp | O seu número pessoal, com o celular ligado e com internet na hora de parear e de pedir histórico. |
| Node | Não precisa: a extensão usa o Node que já vem no Claude Desktop. |

## Instalação manual

O mesmo pacote serve para Mac e Windows.

1. Baixe o `whatsapp-pessoal.mcpb` da [última versão](https://github.com/thaleslaray/whatsapp-claude/releases/latest) e dê dois cliques nele. Confirme a instalação. Não há senha nem chave para preencher.
2. Em "Limite de respostas por dia", deixe 30 ou escolha de 1 a 200. Em "Conversas novas por dia", deixe 5 ou escolha de 0 (desliga) a 20.
3. Feche o Claude Desktop de vez e abra de novo (no Mac, **Cmd+Q**; no Windows, **Sair** no menu do ícone perto do relógio).
4. Comece uma **conversa nova**. Se aparecer um pedido de acesso às Chaves (Keychain) para o `security` no Mac, clique em **Permitir**.
5. Faça o [pareamento](#parear).
6. Para a skill, baixe o código-fonte da mesma versão e copie a pasta `skill/rotinas-whatsapp/` para `~/.claude/skills/rotinas-whatsapp/` (ou use o pacote `skill/rotinas-whatsapp.skill`).

## Desconectar

Peça "desconectar o WhatsApp" e clique no cartão. O aparelho sai de Aparelhos conectados e tudo é apagado deste computador: sessão, mensagens (com as transcrições) e listas. Só as contagens do dia (respostas, conversas novas, reações, pedidos de histórico e mídias abertas) continuam valendo. Os arquivos abertos em `Downloads/WhatsApp Claude` e o modelo de transcrição (subpasta `modelos`) não são apagados.

Se a chave do cofre deste computador se perdeu (ou um arquivo foi alterado), o cartão de desconectar aparece mesmo assim e apaga tudo o que conseguir. Depois, é só parear de novo.

## Onde ficam os dados

- **Mac:** `~/Library/Application Support/whatsapp-claude` (dados) e `~/Library/Logs/whatsapp-claude` (registro de ações).
- **Windows:** `%LOCALAPPDATA%\whatsapp-claude` (dados) e `%LOCALAPPDATA%\whatsapp-claude\logs` (registro de ações).

## Onde fica a chave

A chave que cifra tudo é sorteada na primeira vez que a extensão liga e guardada sem você fazer nada:

- **Mac:** no Keychain (Chaves), item `whatsapp-claude`, conta `chave-aes`.
- **Windows:** protegida pela proteção de dados da sua conta do Windows (DPAPI), num arquivo `cofre-chave.dpapi` na pasta de dados. Só a sua conta, neste computador, consegue abrir.

**Quando a chave se perde no Windows.** Se a senha da conta for redefinida por um administrador, se o perfil do Windows for recriado ou se a pasta de dados for copiada para outro computador, o Windows não abre mais a chave antiga. A extensão guarda o arquivo antigo como `cofre-chave.dpapi.antiga`, cria uma chave nova, e as conversas guardadas com a antiga não abrem mais: peça "desconectar o WhatsApp" (o cartão aparece mesmo assim) e pareie de novo.

Se o Windows PowerShell estiver bloqueado (antivírus ou política da empresa), a extensão não apaga nada: avisa que não conseguiu usar a proteção de dados do Windows e tenta de novo sozinha.

**O que a cifra protege, e o que não protege.** A chave fica presa à sua conta deste computador. Então a cifra protege as conversas guardadas se o disco for roubado ou copiado, se um backup for parar em outro lugar e contra outro usuário do mesmo computador. Ela **não** protege contra um programa malicioso rodando na sua própria conta: no Mac, o item do Keychain é criado pela ferramenta `security` do sistema, e qualquer programa da sua conta consegue lê-lo sem pedir senha; no Windows, qualquer programa da sua conta pode pedir à DPAPI para abrir o arquivo. Isso é um limite do jeito como o Mac e o Windows guardam chaves para programas de linha de comando, não um defeito que dê para fechar aqui.

## Para quem desenvolve

O código está em [`mcp/`](mcp/), em TypeScript, com 635 testes que não usam a rede. [`FICHA.md`](FICHA.md) tem a especificação e os desvios de cada versão. Dentro de `mcp/`:

- `npm test` e `npm run typecheck`;
- `npm run pack`: gera `whatsapp-pessoal.mcpb`. Antes do build, `scripts/nativos.mjs` baixa uma vez (com `npm pack`, para `mcp/nativo/`, fora do git) os motores de transcrição `@fugood/node-whisper-<sistema>-<arch>@1.2.0-rc.2`, confere a integridade (sha512) e o sha256 de cada `index.node` e os põe em `mcpb/server/nativo/`;
- `npm run autoteste`: extrai o pacote e testa o servidor dele, sem rede e sem WhatsApp (roda no Mac: usa o `unzip` do sistema). Com `WA_TESTE_MODELO=<caminho do ggml-small-q5_1.bin>` (e `WA_TESTE_AUDIO=<um .ogg>`, ou `<pasta do modelo>/../audio/a60.ogg`), transcreve também um áudio de verdade pelo pacote; sem ela, essa parte é pulada e o autoteste diz isso;
- `npm run check`: tudo isso em sequência;
- `node scripts/chamar.mjs '[{"name":"wa_buscar","arguments":{"texto":"x"}}]'`: chama o servidor recém-construído contra os dados reais deste computador, como cópia leitora, sem reinstalar a extensão (precisa do Claude Desktop aberto e conectado; só as leituras rodam com o código novo). `--ferramentas` lista o que ele anuncia.

## Licença e aviso

[MIT](LICENSE). Feito por [Thales Laray](https://thaleslaray.com.br).

Este projeto não é do WhatsApp, da Meta nem da Anthropic, e não tem ligação com eles. É um cliente não oficial, que viola os termos do WhatsApp e pode levar ao banimento do número. Use por sua conta e risco.
