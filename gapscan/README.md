# GapScan — editable source project

Open this folder in VS Code, Cursor, WebStorm, or any code editor. It includes the current GapScan UI, backend extraction/comparison engine, bundled design-system references, and automated tests, including the comparison crash fixes.

## Start the app

Install Node.js 24 LTS, or use Node.js 22.9 or later. Then open a terminal **inside this folder**:

```sh
npm start
```

Open **http://localhost:4173**. No npm dependencies, API keys, or hosted account are required for the built-in engine. `npm start` builds the app before launching its local backend. `npm run dev` does the same thing.

Do not open `web/index.html` directly: extraction and comparison require the Node backend and browser workers served over HTTP.

## Edit the app

| Location | What to edit |
| --- | --- |
| `web/index.html` | Page structure and controls |
| `web/styles.css` | Layout, spacing, light/dark themes |
| `web/app.js` | Dashboard and report interactions |
| `web/stepper.js` | Source → target → comparison flow |
| `web/comparison-transport.js` | Background browser transport and compressed requests |
| `web/preview.js`, `web/preview-frame.js` | Lazy component previews |
| `web/local-library.js` | Saved design-system library |
| `engine/` | Extraction, taxonomy, matching, scoring, report storage and streaming |
| `server.mjs` | Backend request handlers |
| `references/` | Bundled versioned design-system source inventories |
| `tests/` | Automated engine and transport tests |
| `scripts/build.mjs` | Builds the browser engine and self-contained server |
| `scripts/dev.mjs` | Local Node HTTP adapter |

After editing, stop the server with **Ctrl+C**, run `npm start` again, and reload the browser. There is no automatic file watcher. Edit the source folders above; `worker/` and `dist/` are generated outputs overwritten by each build.

## Validate changes

```sh
npm run build
npm test
npm run check
```

The exported project includes 203 passing tests. The comparison engine runs on the local Node backend; browser workers handle transport, and previews load as they approach the viewport.

## Upgrade guides and migration planning

Before comparison, GapScan checks captured documentation and links from the inputs for installation, upgrade and migration guidance. When guidance is found, you can review it first, skip it, or return to the inputs. Readable instructions retain their document and line evidence. Version coverage is flagged; a wording difference is not treated as proof that a requirement was removed. Inaccessible guides can be opened manually or optionally pasted without blocking comparison. Commands in guides are displayed, never executed.

The overview groups related records into Keep, Update, Find a replacement and Check first. Known changes receive conditional engineering-hour, budget and timeline ranges. Missing evidence stays unestimated. Application usage can be marked manually; affected screens and runtime behaviour remain unchecked until validated. Target-only additions are optional. Work items include tasks, guide evidence, acceptance checks and AI handoff prompts where available. No AI account is required, and no prompt is automatically sent to an AI service.

Edit `web/upgrade-guides.js`, `web/decision-brief.js`, and `web/report-experience.js` for this experience; their matching engine modules are in `engine/`.

## Optional Firecrawl configuration

Copy `.env.example` to `.env` and set `FIRECRAWL_API_KEY` to your own key. Restart the server, open the extraction settings using the gear icon, and select Firecrawl. You can also supply a session-only key in the app's settings. Keep `.env` private; the ZIP contains no API credentials.

The built-in engine works without this configuration. Website crawling, Git imports and CDN-based component previews still need internet access and access to their upstream services.

Change `PORT` in `.env` if 4173 is already in use. The default adapter binds only to this computer. It is intended for local development and has no hosted authentication layer; deploy behind an appropriate authenticated server if you later expose it to other users.

## Saved projects and libraries

Saved projects, decisions and imported libraries belong to browser storage for each URL. Data saved on the hosted GapScan URL does **not** automatically appear on localhost. Export the projects/libraries from the hosted app, then import them into the local app. This source package contains the bundled public references, not your browser's personal saved data.

## Hosting and source provenance

This export is independent of the existing live site: it contains no Git history, repository credentials, or live Site project ID. `.openai/hosting.json` is an empty build-compatibility manifest. Editing or running this project does not update the hosted app.

`server.mjs` uses the standard Worker `fetch` interface. `scripts/dev.mjs` adapts it to Node for local use. The build emits `worker/index.js` and `dist/server/index.js`; configure a new deployment and its storage/access rules separately if you want your own hosted instance.

Bundled third-party design systems retain their upstream licensing requirements. Their repository/version/license provenance is recorded in `references/index.json` and individual reference files. `reference/` contains the supplied specification and older prototypes; they are not the running UI. `docs/ENGINE-HISTORY.md` preserves earlier implementation notes and may describe historical behavior.
