# Regras do Projeto — Opel Corsa B 1998 (San Francisco 3D)

## Versionamento e Publicação Obrigatória no GitHub

1. **Incremento de Versão (+0.01)**: Toda alteração de funcionalidade, física, visual ou correção de bug no jogo deve incrementar a versão em `+0.01` de forma consistente em ambos os arquivos:
   - `GAME_VERSION` em `game.js`
   - `#game-version-badge` em `index.html`
2. **Validação Antes do Envio**: Antes de commitar, verifique integridade de sintaxe, referências de assets e regras do projeto sem deixar arquivos temporários ou servidores rodando no diretório de trabalho.
3. **Commit e Push Automáticos para o GitHub**: Após concluir e validar qualquer nova versão ou atualização do projeto, **sempre** execute o fluxo completo até o repositório remoto sem precisar pedir confirmação prévia ao usuário:
   - `git status` para confirmar apenas os arquivos do projeto pretendidos
   - `git add` nos arquivos alterados
   - `git commit` com mensagem descritiva iniciando pela versão (ex.: `v1.09: ...`)
   - `git push origin main`
4. **Confirmação Final**: Informe ao usuário a versão publicada, o hash do commit e o resultado do push.

