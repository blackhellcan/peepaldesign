// What every source adapter produces. Observations are raw facts with a
// locator back to the source; the pipeline turns them into tokens, scales,
// components and findings.
import type {SourceChannel} from '@gapscan/normalize';

// `rendered` marks computed browser values, which are always literals and never prove hard-coding.
type Base = {channel: SourceChannel; locator: string; raw?: string; rendered?: boolean};
export type Observation = Base & (
  | {type: 'color'; value: string; name?: string; role?: string; property?: string; selector?: string; count?: number}
  | {type: 'font'; family: string; size?: string; weight?: string; lineHeight?: string; role?: string; selector?: string; count?: number}
  | {type: 'spacing'; value: string; count?: number}
  | {type: 'radius'; value: string; count?: number}
  | {type: 'shadow'; value: string; count?: number}
  | {type: 'contrast'; foreground: string; background: string; selector: string; large: boolean; count?: number}
  | {type: 'token'; path: string; value: string; tokenType?: string; description?: string}
  | {type: 'component'; name: string; html?: string; css?: string; states?: string[]; variants?: string[]; props?: {name: string; type: string; values?: string[]}[]; screenshot?: string;
      variantStyles?: {name: string; style: VariantStyle; count: number; html?: string; text?: string; states?: VariantStates; screenshot?: string}[]}
  | {type: 'text'; kind: 'voice' | 'heading' | 'microcopy' | 'rule'; text: string}
  | {type: 'asset'; kind: 'logo' | 'image' | 'font-file'; name: string}
);

// How one variant of a rendered component actually looks (computed styles of a representative instance).
export type VariantStyle = {background: string; color: string; border: string; radius: string; fontSize: string; fontWeight: string; fontFamily: string;
  paddingY: string; paddingX: string; height: string; width: string; shadow: string; outline?: string; opacity?: string; textDecoration?: string};
// What changes in a variant's look under :hover, :focus-visible, :active or when disabled (only the changed properties).
export type VariantStates = Partial<Record<'hover' | 'focus-visible' | 'active' | 'disabled', Partial<VariantStyle>>>;

export type AdapterInput = {assetId: string; name: string; uri: string; bytes: Uint8Array};
// `refresh` asks adapters that keep saved copies (websites) to read the source again.
export type AdapterContext = {signal: AbortSignal; fetch?: typeof fetch; progress?: (message: string) => Promise<void> | void; refresh?: boolean};
export type AdapterResult = {
  observations: Observation[];
  fetched: number;                                   // pages, slides, files or nodes actually read
  failed: {locator: string; reason: string}[];
  budgetHit: boolean;
  viewports?: number[]; themes?: string[];
  reused?: number;                                   // saved pages reused instead of read again
};
export type Adapter = (input: AdapterInput, context: AdapterContext) => Promise<AdapterResult>;

export class AdapterError extends Error {
  constructor(message: string) { super(message); this.name = 'AdapterError'; }
}
