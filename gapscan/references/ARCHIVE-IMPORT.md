# Version-pinned archive refresh

The 11 reference records were re-indexed from official Git repository ZIP archives and the supplied Bootstrap 6 alpha ZIP. `retraining-report.json` records before/after evidence counts, pinned commits, and SHA-256 archive hashes. Counts describe implementation identifiers, tokens, API declarations, and example records; they are not unique public component counts.

The GitHub topic and organization links are discovery indexes, not importable design systems. Their relevant Bootstrap repositories/releases are represented separately. Blueprint 6, Fluent UI React 9 and Spectrum 1st-generation packages retain their declared version scope; unrelated generations are excluded.

Reproduce the source preparation without running downloaded project scripts:

```sh
python3 scripts/download-reference-zips.py /path/to/archives --bootstrap-zip /path/to/bootstrap-6.0.0-alpha.1.zip
python3 scripts/prepare-reference-zips.py /path/to/archives/manifest.json /path/to/prepared
node --max-old-space-size=8192 scripts/retrain-archive-references.mjs /path/to/prepared BASELINE_COMMIT
npm run build
npm run check
npm test
```

Each profile retains its complete selected source files, archive provenance, omitted-file reasons, source ledger, revision and extracted evidence counts. The UI refreshes built-in local copies when their revision changes. Personal uploads and saved migration reports are preserved. Browser storage remains per device/origin and backups are recommended.

Static source extraction cannot prove every runtime state or accessibility rule. Missing runnable examples remain documented unknowns rather than fabricated previews or upload requirements. Typed variants and boolean state props are explicitly labelled as API declarations, with runtime behavior unverified.
