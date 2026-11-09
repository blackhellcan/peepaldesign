# GapScan evidence engine v9

A server-backed design-system comparison app based on the workflow in `../gapscan.zip`. The original HTML and ZIP are unchanged.

## Run locally

```sh
npm run build
npm run dev
```

Open http://localhost:4173. No dependencies or API keys are required. Node.js 22 or newer is recommended. Rebuild and restart after source changes.

## Workflow

1. Select version upgrade or framework switch.
2. Provide current and target inputs independently: public HTTPS link, public npm package/version, pasted code/file, or a combination.
3. Extract the current system first, then the target system, then compare.
4. Review independent Source and Target extraction tabs. The Gap analysis tab includes only the comparison report, with status/domain charts, included effort allocation, a priority queue, and chart drill-down. Supporting material is filtered before comparison, with an exclusion ledger available in the extraction tabs. Component evidence links use actual heading anchors; raw file sources are shown as code evidence without hyperlinks.
5. Edit effort and included scope; use the separate Estimation calculator tab for application costs and team timelines.
6. Export JSON, standalone `estimation-report.html`, and `gap-analysis-report.md`.

New scans start with blank sources and no assumed migration or preset component inventory. The demo only loads on explicit request.

## Extraction

- Server collection follows same-origin links within the supplied documentation path, honoring a user-visible 1–40 page/file budget.
- Public GitHub repositories use the GitHub tree API; blob links convert to raw source URLs. API throttling, blocked pages, and truncated trees are reported.
- Supports CSS/Sass tokens, nested JSON tokens, CSS selectors, component exports, prop interfaces, function signatures, JSX references, Markdown/HTML headings, and HTML examples.
- Dynamically catalogs observations, with no fixed element-count ceiling. Requests are bounded to 300 KB of pasted code per input, 1.5 MB per remote document, 4 MB per input collection, and a roughly 45-second collection deadline.
- Maps normalized identifiers and common component aliases; token-family matches are tentative and explicitly marked for review.
- Changed definitions, renamed identifiers, target-only additions, source-only observations, and unchanged observations are separate states.
- CSS-only previews use labeled markup probes. HTML previews are sandboxed without scripts and disallow external resources. Non-runnable definitions remain evidence text.

This is a deterministic extraction engine, not a Gemini integration. The supplied skill is a prompt/specification rather than executable engine code. No claim of whole-site completeness or semantic equivalence is made. Documentation that requires JavaScript/authentication, private Figma files, undocumented components, and complex parser constructs require exported code or manual review. A source-only finding is not confirmed removal.

## Estimates

Estimates are heuristics per application: token changes 1–2h, API changes 6h, component changes/additions/source-only observations 3–8h; matched changed components gain 4h for a framework switch. Unchanged observations start at 0h, and manual validation effort can be added. The app exposes editable hours, application count, USD hourly rate, team size, and QA buffer. Timeline uses 35 productive hours per engineer per week.

## Source and hosting

`web/` contains the UI. `engine/` implements collection, extraction, and comparison. `server.mjs` streams actual scan-stage events. `scripts/build.mjs` generates a self-contained Cloudflare Worker with embedded assets. `.openai/hosting.json` retains the existing private Site identity. `reference/gemini-gapscan-SKILL.md` is the supplied specification; `reference/previous-dashboard.*` preserves the prior version.

Run `npm test` for extraction, matching, crawling, and input-validation tests; `npm run check` validates the generated Worker.

## Relevance layer

After each extraction, the engine removes support-only observations: documentation headings, docs chrome/syntax highlighting, archived/test/story fixture sources, package metadata and tooling configuration. Valid runtime code examples embedded in guides remain included. Mixed identifiers are reconstructed from retained observations so supporting prose cannot inflate their change status. Both inventories retain exclusion counts and reasons. The filter is heuristic; review the ledger. If one inventory has no implementation evidence, the comparison is explicitly marked incomplete.

## Complete tiered catalog (engine v4)

`taxonomy.items` contains every item in the extracted source and target master lists, including supporting and unmatched material. Collection follows primary categories, then secondary categories, then others; each category follows primary_items, secondary_items, other_items. Miscellaneous retains anything unmatched. Each record includes system, canonical category, tier, rank, source references, and an occurrence ID. `taxonomy.coverage` verifies equal master/collected counts and unique occurrence membership, failing on loss or duplication. Counts are reported per tier, category, and system, including nested system breakdowns.

The existing implementation-only comparison and seven-domain dashboard remain separate compatibility views; they do not define master-catalog coverage. Legacy categories are preserved as `legacyCategory` in the catalog. Compound names use their most specific match; ambiguous grid/icon/drawer cases use primary job and cross-references. No UI files were changed for this engine update.

## Registry and website intake (engine v5)

The supplied `engine/design_systems_db.json` is an imported 11-system snapshot. Lookup precedence is domain (with hostname/path boundaries), class signals, package names, then page text. Intake confirms a public URL can be read. Fresh mapped records supply their stored category facts without deep scanning. Partial and stale maps carry limits and refresh options; stubs without a component map require an explicit live-scan decision. Version-specific `/docs/x.y/` links cannot silently use another stored version. Cached inventory facts have no verified code/style/API equivalence and do not receive automatic engineering estimates.

Each `/api/scan` input supports engine-only flags (strict boolean true):

- `refreshRegistry`: scan live sources rather than using a stored map.
- `scanIncompleteConsent`: permit scanning a partial/stub record.
- `allowDerived`: permit deriving a design system from a non-documentation website.

Without derivation consent, the NDJSON API emits an error with `code: confirmation_required` and `confirmation` metadata identifying the input, action, and required flag. The UI files remain unchanged: this is a backend consent contract, not a new clickable consent flow. Code-only inputs continue to work directly.

Consented derivation samples linked public pages, prioritizes stylesheets and form/listing/content routes, inventories CSS variables then repeated stylesheet values, semantic controls/landmarks, page-template signals, and aggregate short UI-label properties. It reports occurrences, source pages, Observed/Inferred/Uncertain confidence, and missing sample/JavaScript/login coverage. Media/font assets are not downloaded or copied; long prose and embedded SVG content are replaced in derived samples. Derived results are labeled “inferred from the live site, not an official design system.”

Live registry refreshes return a partial `refreshCandidate` for the current request. They do not overwrite the supplied registry file or persist a verified map; `persisted: false` is explicit. JSON results include `inputProcess`, `definitionComparisonAvailable`, and the complete loss-checked `taxonomy` catalog independently of existing UI views.

## Visual comparison and local source library (engine v6)

Comparison requests now scan live implementation data by default; registry-only inventory lookup remains available only with an explicit `registryOnly: true` flag. Unreadable sources and missing packages now remain coverage issues in a partial report. Both inputs are processed even when one yields no items. Uploads are optional. Registry facts cannot fill missing implementation evidence.

Examples retain extracted HTML and relevant CSS, resolve transitive CSS variables, and show observed default/hover/focus/active/disabled rules. CSS-only visual specimens use labeled inferred markup; unsupported JS/React behavior is not executed. Color swatches and typography specimens accompany component previews. Missing states remain explicitly unverified. Insights include property/state deltas, token consumers, concrete actions, validation steps and priorities. A side-by-side table groups Colors, Typography, Components, and other foundations.

Settings stores uploaded source files in IndexedDB on the current device and origin. Saved systems can be selected as source or target. Comparisons involving this local library require local files or pasted code on both sides and run through the same pure-JavaScript engine in the browser (`/local-engine.js`), without uploading source files. This is a reference library, not AI model-weight training. Export a library backup before clearing browser storage. Localhost and the hosted Site are separate browser origins and do not share saved libraries.

## Version 8: optional recovery and package extraction

Public npm names, exact versions/tags and npmjs.com/package links are supported per input. The engine resolves the requested version through npm metadata, indexes that exact published package via jsDelivr, and statically reads a balanced sample of CSS/Sass, token JSON, typography, icons and component/type declarations. File hashes are verified. Transient HTTP failures retry once, and package file retrieval can fall back to the same pinned version on unpkg. No install scripts execute. Source and target retain separate package/version ledgers.

Package references in source/install instructions are discovered automatically. Known families may supply an explicitly labelled companion implementation when their website lacks usable evidence. A companion is not proof of the website's installed implementation or version; specifying the npm package overrides it. Sampling reads 12–40 package files per input, in addition to the documentation budget, within the input deadline. Remaining files are listed as unscanned. Dependency package names are recorded; arbitrary dependency trees are not installed or executed.

Partial coverage never hides galleries, comparison, exports or the calculator. Matched definitions remain comparable. All unmatched and unresolved items are `Unverified`, with zero automatic effort and no inferred removal or creation. Estimates cover observed matched changes only. An input yielding zero implementation items is explicitly audited and never filled with fabricated components. Optional packages, alternate links or uploads can improve evidence. Invalid inputs and unapproved derived website scans still return actionable errors.

## Prepared design-system references

The local-training form and manual npm input controls have been removed. Documentation/code/local-library inputs remain, with automatic public artifact recovery in the engine. Settings includes prepared reference libraries from the supplied Bootstrap 6.0.0-alpha.1 ZIP and pinned official Material Web, Carbon and Web Awesome Git repositories. The catalog lists versions, commits and the source scope. Choosing a reference builds a local extraction fingerprint once and allows reuse as source or target. This is stored design-system evidence, not AI model-weight training.

Original compiled Bootstrap CSS and static documented examples are retained. MDX literal template examples are parsed without executing computed expressions. Component views prioritize runnable original markup, with documentation buttons when a runnable example is unavailable. Other extracted definitions remain available through All imported items and implementation details.

## Saved projects and design systems

Save project stores a local draft or full report with source/target inputs, scope selections, edited hours, calculator settings and report view. Saved projects can be reopened from Settings without rescanning and individually exported/imported. Imports create new IDs. Project backups do not include the original source files of independently saved local-library profiles; export the library as well for transferring those inputs to another device.

Save design system in either extraction gallery stores the observed inventory/fingerprint, coverage audit and preview assets as a reusable local reference. Website/npm snapshots can be used in local comparisons without uploading source files. Missing evidence remains unverified. Public CDN assets used by the original previews still require network access. The existing local-library backup includes these extracted references as well as category-trained source profiles.

## Report storage

Large evidence strings and preview variants are pooled, token references are stored once, comparison rows refer to the separate source/target inventories, and the full taxonomy retains a compact occurrence/provenance ledger. Hydration restores examples and values for rendering. This reduces report and saved-fingerprint duplication while preserving item counts and comparisons. `/api/scan` result reports with `storageFormat: 1` use `hydrateReport` before consumption; the built-in UI and local project/library storage do this automatically.
