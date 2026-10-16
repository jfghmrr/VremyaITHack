# Эталоны прежней реализации

`fixtures/scoring/*.json` и `fixtures/legacy/perepev.sqlite` созданы прежней версией (React + Fastify), которая сохранена под тегом `legacy-react-fastify`. В рабочем дереве её больше нет: в проекте одна формула оценки — `crates/scoring-core`.

Пересоздать эталоны (результат должен совпасть байт в байт, если прежний код не менялся):

```sh
git worktree add ../perepev-legacy legacy-react-fastify
(cd ../perepev-legacy/legacy && npm ci)
ln -s ../perepev-legacy/legacy legacy          # генераторы ищут прежний код в ./legacy
legacy/node_modules/.bin/tsx tools/fixtures/generate.ts
(cd legacy && node ../tools/fixtures/make-legacy-db.mjs)
rm legacy && git worktree remove ../perepev-legacy
```
