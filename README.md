# TableSpace

A SQL schema as a 3D space you can fly through, with a local AI data architect that acts on the scene. Everything runs in the browser: no backend, no account, and the model (optional) runs on your device with [wllama](https://github.com/ngxson/wllama).

- **Tables are glass monoliths.** Height and depth grow with the row count (log scale), color is the domain, and the face lists keys and columns. Click a table to fly to it; click it again to fold or unfold its columns.
- **Foreign keys are curves** from the key column to the table it references, with particles showing cardinality: one going back and forth for `1:1`, a stream from the one side to the many for `1:N`, streams both ways for `M:N`.
- **Layout is force-directed** (`d3-force-3d`): related tables and tables of a domain cluster together.
- **The AI drawer** drives the scene with seven tools: focus tables, write SQL for a question, trace a query, propose a refactor (ghost tables + migration SQL), audit for anti-patterns (3D badges), seed mock data in dependency order, and reset the view.

## Run it

```bash
bun install        # also copies wllama's wasm into public/wllama/
bun run dev        # http://localhost:5183
bun run test       # unit tests (pure logic)
bun run build      # typecheck + production build in dist/
bun run preview    # the production build with the production headers and CSP, http://localhost:5184
```

## What is real and what is simulated

| | |
|---|---|
| 3D scene, layout, camera, X-ray, exploded view, search (`⌘K` / `Ctrl+K`) | Real |
| Local model: download, sha256 check, load, streaming, tool choice | Real (wllama, in the page) |
| Schema audit (missing FK indexes, orphaned tables, God tables, no PK) | Real analysis of the schema definition |
| Refactor proposals and migration SQL | Real, rule-based (column-prefix groups, lookup columns); nothing is executed |
| Generated SQL (`write_sql`) | Real: compiled from a validated query description, PostgreSQL dialect. Never executed (there is no database) |
| Query execution plans | **Simulated.** There is no database: a step is an index scan when the join or filter column is indexed, otherwise a sequential scan, with costs from the mock row counts |
| Seeded data | **Mock data in memory.** Generated parents-first with valid foreign keys; nothing is written anywhere |
| Databases | **Mock schemas** bundled with the app |

## How the agent works

Small local models can't be trusted to write tool calls free-form, so they don't:

1. **Choose.** The model replies with one tool name, held to a GBNF grammar that only allows names from the list (or `answer`).
2. **Fill.** It writes the arguments as JSON under a second grammar in which table names, domains and presets are enums built from the active database, so it can't name a table that doesn't exist. The result is validated again in TypeScript.
3. **Run.** The tool does its work deterministically and changes the 3D scene.
4. **Explain.** The model streams a short explanation from the tool's facts.

A keyword router backs this up: when the model says `answer` to a request that plainly matches a tool, or a step fails, the match is used. Each answer shows who chose the tool (*chosen by the model*, *keyword match*, or *prompt chip*).

## Writing SQL

Ask a question about the data (*how many orders does each user have? top 10*, *list cancelled orders with total over 10000*) and `write_sql` answers with a query, a sentence saying what it understood, a list of what was checked, and a trace of the query in the scene.

Nobody writes SQL text, the model included. A request becomes a `QuerySpec` (tables, columns, filters, aggregate, grouping, order, limit) and `src/analysis/querybuilder.ts` compiles it:

- **Joins come from the foreign keys.** Tables are connected by the shortest chain of keys, adding the tables in between; tables with no chain between them are refused.
- **Every name exists.** A spec that names an unknown table or column doesn't compile.
- **Values are typed and escaped** from the column's SQL type; a number column compared to text is refused.
- **GROUP BY matches the select list**, and a listing with no limit gets `LIMIT 100`.
- **The finished SQL is read back** by the SQL reader and planned, as a second look; slow scans are listed.
- **Cautions are shown, not hidden:** a `_cents` column compared to a number, a sum that would repeat across joined child rows.

What this guarantees is that the SQL is valid for the schema and joins on real keys. It does not guarantee the query is the one you meant: that depends on how the request was read, which is why the reading is shown in words above the checks.

**How a request is read.** A pattern reader (`inferSpec`) takes what the text states outright: table names, *how many*, *total*, *average*, *per / each / by …*, *top N*, *latest*, `column <operator> value`, status words like *cancelled*. With a model loaded, it is asked a second grammar-constrained question whose values are all enums (the columns of the tables involved, operators, and literals copied from the request), and its answer is filtered by `gateSpec`: a column, filter or ordering is kept only if the request's own words support it, and aggregates, grouping and limits are never taken from the model. That filter exists because of a measurement: Qwen3 0.6B, left alone, added filters like `status = 'signed'`, stray aggregates and `LIMIT 1` to simple requests.

Limits: one SELECT with inner joins, AND-ed filters, one aggregate. No OR, subqueries, HAVING, date arithmetic, outer joins or window functions; a request that needs them gets the nearest query this can express, and the "what I understood" line is where that shows.

**Scripted mode.** With no model loaded, the keyword router picks the tool and the tool's own summary is the answer. The prompt chips work fully, so the app can be tried before any download. The drawer says when it is in this mode.

Models: Qwen3 0.6B (639 MB) and Qwen3 1.7B (1.1 GB), GGUF files downloaded once from Hugging Face at a pinned commit, verified against a pinned sha256, and kept in the browser's OPFS storage.

## Add a database

1. Copy `src/schema/saas.ts` and describe your tables with the `pk` / `col` / `fk` / `idx` helpers. Each table needs a `domain` (for color and clustering) and a `rows` estimate (for size).
2. Add query `presets` if you want named traces.
3. Add the schema to `SCHEMAS` in `src/schema/registry.ts`.

The schema tests in `src/analysis/analysis.test.ts` then check it: foreign keys point at real columns, presets parse, and seeding produces valid rows.

## Deploy to Firebase Hosting

```bash
firebase hosting:sites:create tablespace-3d   # once; or change "site" in firebase.json to a site you own
bun run deploy:web                            # build + firebase deploy --only hosting
```

`.firebaserc` points at the `aldrick-ai` project. `firebase.json` sends the headers the app depends on:

- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` make the page cross-origin isolated, which gives wllama `SharedArrayBuffer` and so multiple threads. Without them the model still runs, on one thread.
- The CSP allows only what is used: `'wasm-unsafe-eval'` and `worker-src blob:` for wllama, and `connect-src` to Hugging Face for model downloads.

Any other static host works if it can send the same headers. `vite.config.ts` reads them from `firebase.json`, so dev, preview and production agree.

**PWA.** The build includes a web manifest and a service worker (`vite-plugin-pwa`): the app shell is precached, so TableSpace can be installed and opens offline. wllama's wasm is cached on first use; models stay in OPFS. A new deploy takes over on the next visit and reloads the page once.

## Phones

Under 640 px the AI drawer becomes a bottom sheet with the scene above it, tables stay folded until tapped, and the scene is lighter (lower pixel ratio, weaker bloom, fewer particles, no star field). Models load CPU-only with a 2,048-token context on phones, because iOS closes a tab that uses too much memory; a load that fails or crashes the tab steps down further on the next try. `prefers-reduced-motion` stops particle flows and makes camera moves instant.

## What was checked

- `bun run test`: 61 unit tests over the graph, layout, audit, SQL reader, plan simulation, query builder, refactor proposals, seeding, grammar and router. Every generated query in the tests is read back and planned, and every pair of connected tables in both schemas is joined and parsed.
- The production build under `bun run preview`, in headless Chrome at 1440×900 and 390×844 (emulated phone): cross-origin isolated, service worker registered, no console errors or CSP violations; every chip, typed SQL, search, the second schema and the exploded view were looked at in screenshots.
- Qwen3 0.6B loaded in Chrome on a Mac (WebGPU, 29/29 layers, about 125 tok/s) and answered free-form prompts through the agent loop, including seven SQL requests whose output was read by hand. Generated SQL was not run against a real PostgreSQL.

Not checked: a real phone (emulation only, and no model was loaded at phone size), Safari and Firefox, and an actual Firebase deploy.

## Layout

```
src/schema/     schema types, the mock databases, graph helpers
src/layout/     force-directed layout
src/analysis/   audit, SQL reader, plan simulation, query builder, refactor proposals, seeding   (pure, tested)
src/scene/      React Three Fiber components
src/agent/      tools, grammars, prompts, keyword router, the turn
src/llm/        wllama engine, model catalog, device load plans, sha256           (ported from Andai)
src/state/      zustand stores: scene, chat, ui
src/ui/         top bar, dock, command palette, inspector, AI drawer
```
