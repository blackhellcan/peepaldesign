// Shared contracts for every GapScan service. Parts 1–4 of the architecture use
// these names unchanged; API handlers validate with the schemas and code imports
// the inferred types, so a payload and its type can never drift apart.
import {z} from 'zod';

const id = z.string().min(1);
const isoDate = z.string().datetime();
const unit = z.number().min(0).max(1);

// ── Part 1: sources and evidence ────────────────────────────────────────────
export const SourceKind = z.enum(['url', 'figma', 'pdf', 'pptx', 'docx', 'markdown', 'code', 'zip', 'image']);
export const Trust = z.enum(['declared', 'observed', 'inferred']);

export const SourceAsset = z.object({
  id, projectId: id, kind: SourceKind,
  uri: z.string().min(1),                  // public URL, or `inline:<name>` for pasted content
  label: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  blobKey: z.string().optional(),          // stored payload for uploads and pasted code
  budget: z.object({maxPages: z.number().int().positive(), maxBytes: z.number().int().positive()}),
  consent: z.boolean().optional(),
  // Websites: GapScan's own browser (default) or Scrapling's HTTP fetcher.
  reader: z.enum(['default', 'scrapling']).optional(),
  // `system` sources describe the design system; `application` sources are the product code that uses it.
  role: z.enum(['system', 'application']).default('system'),
  createdAt: isoDate,
});

export const EvidenceRecord = z.object({
  id, assetId: id, trust: Trust,
  locator: z.string(),                     // selector, Figma node, pdf page:bbox, file:line
  raw: z.string(),
  context: z.object({viewport: z.number().optional(), theme: z.enum(['light', 'dark']).optional(), state: z.string().optional()}).optional(),
});

export const TokenType = z.enum(['color', 'dimension', 'fontFamily', 'fontWeight', 'typography', 'shadow', 'duration', 'cubicBezier', 'radius', 'other']);
export const Token = z.object({
  id, tier: z.enum(['global', 'semantic', 'component']),
  path: z.string().min(1),                 // "color.primary", "space.4"
  type: TokenType,
  value: z.unknown(),
  aliasOf: z.string().optional(),
  status: z.enum(['resolved', 'unresolved', 'synthesized']),
  modes: z.record(z.string(), z.unknown()).optional(),
  evidence: z.array(id), confidence: unit, usageCount: z.number().int().min(0),
});

export const Tier = z.enum(['primary', 'secondary', 'others']);
export const ComponentObservation = z.object({
  id, canonical: z.string(), rawNames: z.array(z.string()).min(1),
  category: z.string(), tier: Tier,
  variants: z.array(z.object({name: z.string(), tokenRefs: z.record(z.string(), z.string()), specimenId: z.string().optional(),
    // Rendered sites: what changes under hover / focus-visible / active / disabled, and a screenshot of the variant at rest.
    states: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    screenshot: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(400_000).optional()})),
  sizes: z.array(z.string()), statesObserved: z.array(z.string()), statesMissing: z.array(z.string()),
  props: z.array(z.object({name: z.string(), type: z.string(), values: z.array(z.string()).optional()})).optional(),
  // Rendered sites: computed styles of a representative instance at each size (height, padding, font size…).
  sizeStyles: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  a11y: z.object({contrastMin: z.number().optional(), focusVisible: z.boolean().nullable(), role: z.string().optional()}),
  instances: z.number().int().min(0), evidence: z.array(id), confidence: unit,
});

export const Specimen = z.object({
  id, html: z.string().optional(), css: z.string().optional(), screenshotUrl: z.string().optional(),
  origin: z.enum(['captured', 'inferred_probe', 'projected']),
});

export const QuirkKind = z.enum([
  'near_duplicate_token', 'hardcoded_value', 'off_scale', 'declared_observed_drift', 'missing_state',
  'contrast_fail', 'implicit_rule', 'orphan_component', 'unresolved_value', 'coverage_gap',
]);
export const QuirkRecord = z.object({
  id, kind: QuirkKind, severity: z.enum(['info', 'minor', 'major']),
  subjectIds: z.array(z.string()), summary: z.string(),   // plain language, shown to non-engineers
  detail: z.unknown().optional(), evidence: z.array(z.string()),
});

export const CoverageReport = z.object({
  perAsset: z.array(z.object({
    assetId: id, fetched: z.number().int().min(0), skipped: z.number().int().min(0),
    failed: z.array(z.object({locator: z.string(), reason: z.string()})), budgetHit: z.boolean(),
  })),
  viewports: z.array(z.number()), themes: z.array(z.string()),
});

export const ExtractedDesignSystem = z.object({
  id, projectId: id, version: z.number().int().positive(), fingerprint: z.string(), createdAt: isoDate,
  sources: z.array(SourceAsset), evidence: z.array(EvidenceRecord),
  tokens: z.array(Token), components: z.array(ComponentObservation),
  specimens: z.array(Specimen), quirks: z.array(QuirkRecord), coverage: CoverageReport,
  brandSignals: z.object({voiceSnippets: z.array(z.string()), logoAssets: z.array(z.string())}),
});

// ── Part 2: GapScan ─────────────────────────────────────────────────────────
export const ReferenceDS = ExtractedDesignSystem.extend({library: z.string(), libraryVersion: z.string(), pinnedAt: isoDate});

export const MatchStatus = z.enum(['confirmed', 'suggested', 'unresolved']);
export const ComponentMatch = z.object({
  sourceId: id, targetId: z.string().nullable(), score: z.number().int().min(0).max(100),
  status: MatchStatus, reasons: z.array(z.string()),
  approvedBy: z.string().optional(), approvalKey: z.string().optional(),
});

export const DiffDimension = z.enum(['visual', 'variants', 'sizes', 'states', 'api', 'a11y']);
// Driver vocabulary for the 1–5 rubric; points and floors live in @gapscan/estimate.
export const EffortDriver = z.enum([
  'token_value', 'token_rename', 'variant_renamed', 'variant_missing', 'state_missing', 'a11y_fix',
  'prop_rename', 'prop_semantic', 'anatomy_change', 'behaviour_change', 'no_counterpart', 'framework_switch',
]);
// A diff with no driver is a gain the target brings for free (e.g. a built-in loading state): shown, never priced.
export const GapDiff = z.object({
  dimension: DiffDimension, summary: z.string(), before: z.unknown().optional(), after: z.unknown().optional(),
  driver: EffortDriver.nullable(),
});

export const EffortLevel = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export const EffortEstimate = z.object({
  level: EffortLevel.nullable(), label: z.string(), drivers: z.array(EffortDriver),
  low: z.number().min(0).nullable(), high: z.number().min(0).nullable(), basis: z.string(),
});

export const Decision = z.enum(['keep', 'update', 'replace', 'check_first', 'optional']);
export const GapItem = z.object({
  id, name: z.string(), category: z.string(), match: ComponentMatch, decision: Decision,
  diffs: z.array(GapDiff), effort: EffortEstimate,
  variantsInScope: z.number().int().min(1).default(1),
  inferredShare: unit.default(0),           // share of evidence with trust = inferred
  instances: z.number().int().min(0).default(0),
  // From an application scan; absent when no application code was supplied.
  usage: z.object({usages: z.number().int().min(0), files: z.number().int().min(0), screens: z.number().int().min(0), propUsages: z.record(z.string(), z.number().int().min(0))}).optional(),
  quickWin: z.boolean(), breaking: z.boolean(),
  beforeSpecimenId: z.string().optional(), afterSpecimenId: z.string().optional(),
  acceptance: z.array(z.string()),
  tech: z.object({tokenDiff: z.array(z.unknown()), propMap: z.array(z.unknown()), codemod: z.string().optional()}).optional(),
});

export const Assumptions = z.object({
  rate: z.number().positive().default(75), apps: z.number().int().positive().default(1),
  engineers: z.number().int().positive().default(2), qaPct: z.number().min(0).max(200).default(20),
  excluded: z.array(z.string()).default([]),                         // GapItem ids out of scope
  edited: z.record(z.string(), z.number().min(0)).default({}),        // manual low-hour overrides
});

export const GapScanTotals = z.object({
  available: z.boolean(), low: z.number(), high: z.number(), costLow: z.number(), costHigh: z.number(),
  weeksLow: z.number(), weeksHigh: z.number(), complexity: z.number().nullable(),
  levelCounts: z.record(z.string(), z.number().int()), notEstimatedCount: z.number().int(),
  quickWins: z.number().int(), breakingChanges: z.number().int(), productiveHours: z.number(),
  // Hours to update call sites in the application, when usage was scanned; included in low/high.
  consumer: z.object({low: z.number(), high: z.number(), usages: z.number().int(), unusedExcluded: z.number().int()}).nullable().default(null),
});

export const GapScanReport = z.object({
  id, edsId: id, edsFingerprint: z.string(), reference: z.object({id, version: z.string()}),
  items: z.array(GapItem),
  tokenCategories: z.array(z.object({name: z.string(), remappedTokens: z.number().int().min(0)})),
  assumptions: Assumptions, totals: GapScanTotals, exclusions: z.array(z.string()),
});

// ── Part 3: missing architectural objects ──────────────────────────────────
export const ObjectKind = z.enum(['guidelines', 'principles', 'tooling', 'brand', 'accessibility', 'content']);
export const Provenance = z.enum(['extracted', 'inferred', 'drafted']);
export const ObjectSection = z.object({
  id, title: z.string(), status: z.enum(['present', 'partial', 'missing']),
  content: z.string(),                       // Markdown
  provenance: Provenance, evidence: z.array(z.string()),
  approval: z.object({by: z.string(), at: isoDate}).optional(),
  stale: z.boolean().optional(),
  // Written by a language model at a person's request; counts for nothing until approved.
  // `original` is GapScan's own text that the draft replaced, so reviewers can compare.
  // `missing` lists what the section should cover but the extraction doesn't establish (shown highlighted).
  draftedBy: z.object({model: z.string(), at: isoDate, openQuestions: z.array(z.string()), original: z.string().optional(), missing: z.array(z.string()).optional()}).optional(),
});
export const ArchitecturalObject = z.object({
  kind: ObjectKind, title: z.string(), completeness: unit, edsId: id, sections: z.array(ObjectSection),
});

// ── Application impact ─────────────────────────────────────────────────────
export const ComponentUsage = z.object({
  component: z.string(), usages: z.number().int().min(0), files: z.array(z.string()), screens: z.array(z.string()),
  propUsages: z.record(z.string(), z.number().int().min(0)), imports: z.array(z.string()),
  examples: z.array(z.object({file: z.string(), line: z.number().int(), snippet: z.string()})),
});
export const UsageReport = z.object({
  id, projectId: id, createdAt: isoDate, sources: z.array(z.string()),
  filesScanned: z.number().int().min(0), filesSkipped: z.number().int().min(0), screens: z.number().int().min(0),
  components: z.array(ComponentUsage),
});

// ── Part 4: projects and jobs ───────────────────────────────────────────────
export const Project = z.object({id, name: z.string().min(1).max(200), createdAt: isoDate});

export const JobType = z.enum(['extract', 'gapscan', 'generate', 'render', 'usage', 'codemod']);
export const JobStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const TERMINAL_JOB_STATUSES: ReadonlyArray<z.infer<typeof JobStatus>> = ['completed', 'failed', 'cancelled'];
export const Job = z.object({
  id, type: JobType, projectId: id, subjectId: z.string().optional(), status: JobStatus,
  payload: z.record(z.string(), z.unknown()), resultId: z.string().optional(),
  error: z.object({code: z.string(), message: z.string(), retryable: z.boolean()}).optional(),
  createdAt: isoDate, updatedAt: isoDate,
});

// Terminal events carry only a result id, never the payload, so a heartbeat can
// never interleave with a large JSON result on the stream.
export const JobEventBody = z.discriminatedUnion('type', [
  z.object({type: z.literal('progress'), stage: z.string(), done: z.number().int().min(0), total: z.number().int().min(0), message: z.string()}),
  z.object({type: z.literal('warning'), message: z.string()}),
  z.object({type: z.literal('complete'), resultId: z.string()}),
  z.object({type: z.literal('failed'), code: z.string(), message: z.string(), retryable: z.boolean()}),
  z.object({type: z.literal('cancelled')}),
]);
export const JobEvent = z.object({seq: z.number().int().positive(), jobId: id, at: isoDate, body: JobEventBody});

export type SourceKind = z.infer<typeof SourceKind>;
export type Trust = z.infer<typeof Trust>;
export type SourceAsset = z.infer<typeof SourceAsset>;
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;
export type TokenType = z.infer<typeof TokenType>;
export type Token = z.infer<typeof Token>;
export type Tier = z.infer<typeof Tier>;
export type ComponentObservation = z.infer<typeof ComponentObservation>;
export type Specimen = z.infer<typeof Specimen>;
export type QuirkKind = z.infer<typeof QuirkKind>;
export type QuirkRecord = z.infer<typeof QuirkRecord>;
export type CoverageReport = z.infer<typeof CoverageReport>;
export type ExtractedDesignSystem = z.infer<typeof ExtractedDesignSystem>;
export type ReferenceDS = z.infer<typeof ReferenceDS>;
export type MatchStatus = z.infer<typeof MatchStatus>;
export type ComponentMatch = z.infer<typeof ComponentMatch>;
export type DiffDimension = z.infer<typeof DiffDimension>;
export type EffortDriver = z.infer<typeof EffortDriver>;
export type GapDiff = z.infer<typeof GapDiff>;
export type EffortLevel = z.infer<typeof EffortLevel>;
export type EffortEstimate = z.infer<typeof EffortEstimate>;
export type Decision = z.infer<typeof Decision>;
export type GapItem = z.infer<typeof GapItem>;
export type Assumptions = z.infer<typeof Assumptions>;
export type GapScanTotals = z.infer<typeof GapScanTotals>;
export type GapScanReport = z.infer<typeof GapScanReport>;
export type ObjectKind = z.infer<typeof ObjectKind>;
export type Provenance = z.infer<typeof Provenance>;
export type ObjectSection = z.infer<typeof ObjectSection>;
export type ArchitecturalObject = z.infer<typeof ArchitecturalObject>;
export type ComponentUsage = z.infer<typeof ComponentUsage>;
export type UsageReport = z.infer<typeof UsageReport>;
export type Project = z.infer<typeof Project>;
export type JobType = z.infer<typeof JobType>;
export type JobStatus = z.infer<typeof JobStatus>;
export type Job = z.infer<typeof Job>;
export type JobEventBody = z.infer<typeof JobEventBody>;
export type JobEvent = z.infer<typeof JobEvent>;
