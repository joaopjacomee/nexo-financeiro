# Nexo — Gerenciador financeiro pessoal

Aplicação web local para organização financeira pessoal, construída com React, TypeScript, Vite e IndexedDB (Dexie.js). O projeto foi estruturado para ser hospedado gratuitamente no GitHub Pages, sem backend, banco de dados externo ou serviço de autenticação.

> **Privacidade:** os registros financeiros são gravados no IndexedDB do navegador/dispositivo. O GitHub recebe somente o código-fonte. O armazenamento local não é automaticamente criptografado: proteja o dispositivo e faça backups periódicos.

## Requisitos

- Node.js 20 ou superior (recomendado Node 22).
- npm.
- Uma conta GitHub para hospedar o código e ativar GitHub Pages.

## Executar localmente

```bash
npm install
npm run dev
```

Abra o endereço indicado pelo Vite no terminal. Os dados ficam no navegador utilizado; desenvolvimento e produção em domínios diferentes possuem armazenamentos separados.

## Gerar a versão de produção

```bash
npm run build
npm run preview
```

O resultado compilado é criado na pasta `dist/`. Para executar os testes das regras financeiras, use `npm test`. O teste também é descrito na seção de validação abaixo.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub e envie todos os arquivos deste projeto para a branch `main`.
2. No GitHub, acesse **Settings → Pages**.
3. Em **Build and deployment**, selecione **GitHub Actions** como fonte.
4. O workflow em `.github/workflows/deploy.yml` instala as dependências, compila a aplicação e publica `dist/` automaticamente a cada push na branch `main`.
5. Aguarde o workflow terminar e abra a URL apresentada na área Pages do repositório.

O workflow define automaticamente `VITE_BASE_PATH` com o nome do repositório, para que os arquivos funcionem em URLs no formato `https://usuario.github.io/nome-do-repositorio/`.

### Atualizar

Faça as alterações no código, envie um novo commit para `main` e aguarde a execução de **Deploy Nexo to GitHub Pages**. O banco IndexedDB fica no navegador, separado dos arquivos publicados. Mesmo assim, faça backup JSON antes de mudanças importantes ou de trocar de dispositivo/navegador.

## Funcionalidades incluídas

- Dashboard com indicadores de contas, saldo planejado, receitas, despesas e cartões.
- As 19 categorias solicitadas, com criação, renomeação, cor e proteção contra exclusão quando houver registros vinculados.
- Contas bancárias e dinheiro, saldos iniciais, transferências entre contas e histórico.
- Receitas e despesas com categoria, conta, data, observações e status.
- Cartões de crédito com limite, fechamento e vencimento.
- Compras parceladas com distribuição em meses futuros e comprometimento do limite pelo saldo de parcelas ainda não pago.
- Pagamento de fatura com débito da conta escolhida e alocação do valor às parcelas em aberto, sem criar nova despesa.
- Controle de devedores com pagamentos parciais creditados na conta selecionada e sem contabilização como nova renda.
- Caixinhas com metas, aportes, retiradas e acompanhamento de progresso; reservas não são somadas em duplicidade no patrimônio.
- Carteiras CDI, aportes/retiradas, importação CSV/JSON de taxas anuais, cálculo diário pela convenção de 252 dias úteis e histórico discreto fora das transações comuns.
- Abas mensais, orçamento por categoria, relatórios por categoria, calendário de parcelas/movimentações e projeção de seis meses.
- Patrimônio líquido estimado, backup JSON e backup criptografado com AES-GCM/PBKDF2.
- Layout responsivo, manifest PWA e Service Worker para cache básico/offline.

## Regras financeiras importantes

### Cartão de crédito

Uma compra no crédito é cadastrada em **Cartões → Nova compra**, e não como despesa à vista. O valor é dividido em parcelas mensais em centavos inteiros. O saldo planejado de cada mês considera a parcela daquele mês. A conta bancária só é debitada quando o pagamento da fatura é registrado.

O limite comprometido corresponde à soma das partes ainda não pagas das parcelas futuras e atuais. O pagamento de fatura aloca o valor às parcelas mais antigas em aberto, liberando o limite pelo valor efetivamente alocado. O sistema não consulta faturas diretamente no banco.

### Reservas e patrimônio

Aporte em caixinha reduz o saldo livre planejado, mas não reduz o saldo total em contas nem o patrimônio. O valor reservado é apresentado como parte dos saldos, e não adicionado novamente.

### Devedores

Um recebimento parcial é lançado em **Devedores → Receber**. O valor aumenta a conta informada e reduz o saldo a receber. Não é adicionado às receitas do mês.

### CDI

Para não inventar taxas nem depender de um proxy/backend, esta versão exige importação manual de uma tabela histórica de taxas. O arquivo pode ser CSV com cabeçalhos `date,annualRate` ou `data,taxa`, ou JSON com objetos contendo `date` e `annualRate`. As datas devem ser `AAAA-MM-DD`; a taxa anual deve ser um percentual numérico (por exemplo, `13.15`). O sistema recalcula o histórico a partir do valor inicial e dos aportes/retiradas por data, evitando duplicar juros ao importar novamente as mesmas taxas.

Exemplo de CSV:

```csv
date,annualRate
2026-11-24,13.15
2026-11-25,13.15
```

A série importada é tratada como taxa anual efetiva para o cálculo diário `(1 + taxa anual)^(1/252) - 1`. O rendimento é uma estimativa de controle; não substitui a metodologia, os impostos, taxas, liquidez ou extrato oficial do produto financeiro.

## Backup e restauração

Acesse **Configurações** para exportar todos os dados em JSON. O backup criptografado solicita uma senha com pelo menos 8 caracteres; o sistema não guarda essa senha. Para restaurar, selecione o JSON e, caso esteja criptografado, informe a mesma senha. A restauração padrão mescla registros e ignora IDs já existentes.

Guarde backups em local seguro. Limpar dados do site, remover o perfil do navegador ou perder o dispositivo pode apagar o banco local. A PWA não sincroniza dados entre dispositivos.

## Limitações conhecidas desta entrega

A aplicação é local e funcional nos fluxos principais, mas não integra automaticamente com bancos, cartões, Open Finance ou a API do Banco Central. A atualização de taxas CDI depende do arquivo importado pelo usuário. O calendário reúne movimentações e parcelas já registradas, sem agenda recorrente/notificações. O planejamento não cria automaticamente receitas/despesas recorrentes, e o simulador tributário líquido ainda não está implementado. A separação de uma despesa em parte própria e parte de terceiros precisa ser feita com registro da dívida na área Devedores. Não há multiusuário, sincronização ou recuperação remota de dados.

## Estrutura

```text
src/
  App.tsx                 Interface e páginas
  main.tsx                Inicialização React e Service Worker
  types.ts                Tipos das entidades
  lib/
    db.ts                 IndexedDB, Dexie e dados iniciais
    finance.ts            Consultas e cálculos consolidados
    format.ts             Formatação monetária/datas
    operations.ts         Operações financeiras e backup
public/
  manifest.webmanifest   Metadados PWA
  sw.js                   Cache offline básico
  icon.svg                Ícone da aplicação
.github/workflows/
  deploy.yml              Publicação automática no Pages
```

## Testes e validação

Execute `npm test` para validar as regras puras de divisão de parcelas, saldo mensal, reservas, limite do cartão, taxa diária CDI e alocação de pagamento de fatura. Esses testes não substituem uma validação manual no navegador com o banco IndexedDB e os fluxos completos da interface.

## Desenvolvimento

- Valores monetários são armazenados como centavos inteiros.
- Cada registro possui identificador único.
- As tabelas do IndexedDB são versionadas pelo Dexie. Ao alterar o esquema, incremente `this.version(n)` em `src/lib/db.ts` e descreva a migração.
- Nunca comite arquivos de backup nem dados financeiros para o GitHub.
