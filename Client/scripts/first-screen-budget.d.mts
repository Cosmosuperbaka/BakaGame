export interface FirstScreenBudgets {
  entryCssGzBytes: number;
  entryJsGraphGzBytes: number;
  largestChunkGzBytes: number;
  entryFontFaceRules: number;
  emittedFontFaceRules: number;
  emittedFontFiles: number;
  emittedFontBytes: number;
  maxFontFileBytes: number;
  entryJsGraphRawBytes: number;
  entryCssRawBytes: number;
  distTotalBytes: number;
  emittedImageBytes: number;
  duplicateAssetBytes: number;
  logoBytes: number;
  faviconBytes: number;
}

export interface FirstScreenMetrics extends FirstScreenBudgets {
  largestChunkName: string | null;
}

export interface BudgetViolation {
  key: keyof FirstScreenBudgets;
  value: number;
  limit: number;
}

export interface DistSummary {
  totalBytes: number;
  imageBytes: number;
  duplicateBytes: number;
}

export interface DistFiles {
  htmlText: string;
  files: Map<string, Buffer>;
  dist: DistSummary;
}

export const BUDGETS: FirstScreenBudgets;

export function analyze(input: {
  htmlText: string;
  files: Map<string, Buffer>;
  dist?: DistSummary;
  budgets?: FirstScreenBudgets;
}): { metrics: FirstScreenMetrics; violations: BudgetViolation[]; budgets: FirstScreenBudgets };

export function evaluate(
  metrics: FirstScreenMetrics,
  budgets: FirstScreenBudgets
): BudgetViolation[];

export function readDist(distDir: string): Promise<DistFiles>;

export function checkFirstScreenBudget(distDir?: string): Promise<{
  metrics: FirstScreenMetrics;
  violations: BudgetViolation[];
  lines: string[];
}>;
