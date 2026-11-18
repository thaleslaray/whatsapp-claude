# Limites do MCP "WhatsApp pessoal" que afetam as rotinas

Leia uma vez por conversa. Cada item veio de uso real e evita uma conclusão errada ou uma promessa que a ferramenta não cumpre.

## O que a extensão enxerga

- **Só com o Claude Desktop aberto.** O que chega com o aplicativo fechado não é guardado, a não ser o que o celular mandar no pareamento seguinte. Um relatório nunca cobre "tudo"; cobre o que está guardado. Diga o intervalo.
- **Há um teto de mensagens guardadas por conversa:** 5.000 a partir da extensão 0.9.2, 500 antes dela. O `wa_estado` diz qual vale (`maximo_por_conversa`). As mais antigas saem. Conversa que está no teto tem mais história no celular.
- **Conversas individuais: todas, menos as da lista "nunca ler".** Grupos: só os que o dono escolheu, e só a partir da escolha.
- **Grupo recém-incluído começa vazio.** Enquanto não chegar uma mensagem nova, não há nada para ler nem ponto de partida para pedir histórico, e `wa_ler_conversa` e `wa_responder` devolvem "Não há mensagens guardadas dessa conversa".

## Quem escreveu, em grupo

Em grupo, o WhatsApp muitas vezes entrega só o identificador novo da pessoa (LID), sem o telefone. O que a extensão faz com isso depende da versão:

- **A partir da 0.11.0:** todo remetente de grupo traz `participante` (um rótulo como `p_1a2b3c4d`), estável dentro da conversa. A mesma pessoa repete o mesmo rótulo, então dá para contar pessoas distintas, ver quem pergunta e quem responde, e achar quem sumiu, mesmo sem saber o número. Quando a extensão conhece o número (ela aprende com a lista de participantes dos grupos escolhidos), ele vem inteiro no lugar de "número oculto" (até a 0.18.0 vinha mascarado). O rótulo não é o nome de ninguém: no relatório, use o nome quando houver e, sem nome, "participante 1", "participante 2", na ordem em que aparecem.
- **Antes da 0.11.0:** o remetente vem só como "número oculto". Não dá para contar pessoas nem dizer quem ajuda quem; escreva "não deu para saber" em vez de estimar.

Em qualquer versão dá para responder citando a mensagem (`citar`), porque isso usa o id da mensagem, não o da pessoa.

## Histórico mais antigo (`wa_buscar_historico`)

- É experimental: depende de o celular responder. Já funcionou em grupo e em conversa individual com um celular, e só em grupo com outro (iPhone). Quando não vem resposta, a ferramenta devolve `chegou: false` e um `diagnostico`. Não insista: há um freio de 30 segundos por conversa e 30 pedidos por dia.
- Traz no máximo 50 mensagens por pedido, sempre anteriores à mais antiga guardada. Precisa de pelo menos uma mensagem guardada na conversa.
- Use só quando o dono quiser ir mais para trás. Não gaste pedidos em toda rotina.

## Cartões de confirmação

- Chame a ferramenta que mostra cartão **sozinha**, sem outra chamada na mesma mensagem, e uma de cada vez.
- Às vezes o cartão não desenha e aparece um bloco de texto no lugar dos botões. Nada aconteceu. Chame a mesma ferramenta de novo; se repetir, peça ao dono para fechar o Claude Desktop de vez e abrir de novo.
- No cartão do lote (`wa_responder_lote`), caixa de mensagem vazia trava o envio. Se o dono quiser tirar uma das mensagens, cancele (`wa_cancelar`, não envia nada) e abra outro lote sem ela.
- O dono pode editar o texto dentro do cartão antes de enviar. Por isso o rascunho é ponto de partida, não versão final.
- O cartão de cancelar não manda nada; conferir depois (`wa_ler_conversa`) é o que prova se uma mensagem saiu.
- O envio começa desligado depois de cada pareamento. `wa_envio` liga, também com cartão.

## Áudio e mídia

- `wa_transcrever` roda neste computador e pede, na primeira vez, o download de um modelo (cartão). O texto é automático: erra nomes e números. Marque `[trecho incerto]`.
- `wa_abrir_midia` salva o arquivo sem cifra numa pasta de Downloads. Só quando o dono pedir para ver.
- Nota de voz longa num grupo pode conter exatamente a resposta que a rotina procura. Se não abrir, diga que existe e que não foi ouvida.

## Listas e leituras grandes

- `wa_listar_grupos` sem `filtro` devolve todos os grupos da conta. Em conta com muitos grupos a resposta passa de 60 mil caracteres e estoura o limite. Use sempre `filtro` com um pedaço do nome.
- `wa_ler_conversa` pode devolver menos mensagens do que o `limite` pedido, com o aviso de que cortou para caber. Não é o fim da conversa: continue com `antes_de` até o `mais_antigas` vir vazio.
- Com `desde_o_ultimo_resumo`, `guardadas_no_total` conta só o que veio depois da marca, não o total da conversa.
- Dois contatos sem nome salvo podem aparecer com o mesmo nome mascarado. O campo `numero` e o id da conversa diferenciam.

## Buscas

- `wa_buscar` procura palavras, não a frase inteira: todas precisam aparecer na mensagem, em qualquer ordem, sem diferença de acento ou maiúscula, e a última vale como começo de palavra. Procura também nas transcrições de áudio e nos nomes de arquivo; `achado_em` diz onde achou. Não entende sinônimo.
- Os resultados vêm por relevância; para ordem de data, use `ordem: "recentes"`. `total` diz quantos achados existem e `proximo` traz a página seguinte. Dá para filtrar por `conversa`, `de_mim`, `desde` e `ate`.
- A partir da 0.9.0 a busca junta os achados por bloco de conversa (mensagens seguidas, com até 15 minutos de silêncio entre elas): um resultado por bloco, e `total` conta blocos. `bloco.achados` diz quantas mensagens do bloco casam. Resultado com `espalhado: true` quer dizer que as palavras estão em mensagens diferentes do mesmo bloco: é um achado mais fraco, leia o bloco antes de concluir. Para uma linha por mensagem, use `agrupar: "mensagem"`.
- `por_conversa` (na primeira página) mostra as conversas com mais achados: use para decidir onde ler, em vez de paginar tudo.
- Para conferir uma citação, busque duas ou três palavras características dela e leia em volta com `em_volta_de` no `wa_ler_conversa` (o `mensagem_id` do achado). Mensagem do próprio dono volta em `trecho`. Se quem escreveu errou a digitação, a busca pela palavra certa não acha: busque outra palavra do trecho ou use `em_volta_de`.
- Em extensão anterior à 0.8.0 nada disso existe: a busca é por trecho exato, só no texto da mensagem, sem `total`. Se a resposta não trouxer `caminho`, é o caso.
- `encerramento_provavel` em `wa_listar_conversas` é calculado por regra fixa (figurinha, só emoji, texto curto de fecho como "valeu" ou "ok"). Acerta o caso comum e erra nos dois sentidos: um "ok" pode ser a resposta que destrava um pedido do dono, e um fecho com palavra fora da lista não é reconhecido. Trate como pista para ordenar e para não ler por padrão; leia mesmo assim quando o dono pedir passada cuidadosa ou a pessoa for prioridade.
- O filtro por nome em `wa_listar_conversas` pode não achar grupo cujo nome começa com emoji. Sem filtro, o grupo aparece.

## Memória (resumos e compromissos, a partir da 0.10.0)

- Fica só neste computador, cifrada, e some junto com a conversa: bloquear, tirar grupo e desconectar apagam a memória dela. Mensagem apagada para todos por quem escreveu leva o compromisso que a citava e o resumo que a cobria.
- O servidor confere a citação e a data; não confere se a IA entendeu certo. Um compromisso anotado pode ser brincadeira, e um prazo pode ter sido remarcado por ligação.
- `resumido_ate` e `novas_desde_o_resumo` dizem a idade do resumo. Resumo com mensagens novas depois dele está velho: leia as novas antes de usar.
- Compromisso cuja mensagem saiu pelo teto de mensagens continua na memória, com a citação copiada.

## Aprendizado do jeito do dono (a partir da 0.12.0)

- O que a extensão mede é forma: tamanho, quebra, caixa, pontuação, emoji, aberturas e fechos. Ela não mede conteúdo, humor nem intenção, e não sabe quem é cliente ou família se o dono não disser.
- Mensagem com link e texto idêntico repetido muitas vezes ficam fora da medida, para mensagem de sistema não contar como jeito dele. O perfil diz quantas saíram (`fora_da_medida`).
- Mensagem enviada de rascunho da IA sem edição não entra na medida, para a IA não aprender com ela mesma. Rascunho enviado antes da 0.12.0 não tem essa marca e entra.
- Com menos de 20 mensagens do dono numa conversa, o perfil dela é fraco (`amostra_pequena`): apoie-se no geral.
- Parecer com o dono não torna a resposta certa. Texto no jeito dele dá mais crédito a um fato errado. O conteúdo continua vindo da conversa e do que ele disser.
- O aprendizado fica só neste computador, cifrado, e some com a conversa: bloquear, tirar grupo e desconectar apagam o que se aprendeu dela.

## Grupos e histórico (a partir da 0.13.0)

- Grupo recém-escolhido começa vazio, então não há o que aprender dele. `wa_buscar_historico` com `ate_total` (até 2.000) puxa as mensagens antigas em segundo plano; chamar de novo mostra o progresso. Só quando o dono pedir: cada 50 mensagens é um pedido ao celular, há um limite por dia, e volume alto em pouco tempo pode chamar a atenção do WhatsApp.
- `wa_como_eu_respondi` só acha o que está guardado e só liga pergunta e resposta por citação ou por sequência curta. Resposta dada em áudio, por ligação ou muito depois da pergunta não aparece. Não achar não quer dizer que ele nunca respondeu.

## Riscos que o dono deve conhecer

- A conexão é por cliente não oficial. Os gatilhos de restrição mais relatados são primeiro contato com desconhecidos, volume alto e envio em rajada. As rotinas desta skill não fazem nenhum dos três.
- Mensagens de terceiros passam por um modelo de IA. Em grupo de alunos ou clientes, vale avisar nas regras do grupo que as mensagens são lidas por IA para resumo e suporte. Isto não é orientação jurídica.
