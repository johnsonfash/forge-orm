# 13 · Full-text search

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/johnsonfash/forge-orm-examples/tree/main/13-fulltext-search)

Mark a column `.search()` and the DDL emits the right FTS index per dialect (`tsvector` + GIN on Postgres, `FULLTEXT` on MySQL, FTS5 virtual table on SQLite, etc.). Query with `where: { col: { search: "..." } }`.
