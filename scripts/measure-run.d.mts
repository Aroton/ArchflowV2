export interface ModelRateCard {
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  inputIncludesCached?: boolean;
  longContextAbove?: number;
  longContextMult?: number;
}

export declare const PRICING: Record<string, ModelRateCard>;

export declare function calcMessageCostUsd(model: string, usage: Record<string, unknown>): number;

export interface ParsedTranscript {
  byModel: Record<
    string,
    {
      turns: number;
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      cacheWrite5mTokens: number;
      cacheWrite1hTokens: number;
      outputTokens: number;
      thinkingTokens: number;
      costUsd: number;
    }
  >;
  firstTs: string | null;
  lastTs: string | null;
  maxContextTokens: number;
  turns: number;
}

export declare function parseClaudeTranscript(filePath: string): ParsedTranscript;
export declare function classifySubagent(agentType: string, description: string): string;

export interface ParsedReview {
  rows: Array<{
    id: string;
    severity: string;
    source: string;
    origin: string;
    isStructure: boolean;
    isPostR1: boolean;
  }>;
  decisions: Record<string, number>;
  hasR2: boolean;
}

export declare function parseReviewFile(content: string): ParsedReview;
export declare function parseGateFile(content: string): { critical: number; major: number; minor: number; note: number };
export declare function measureRun(options: Record<string, unknown>): Record<string, unknown>;
export declare function compareRuns(
  beforeRun: Record<string, unknown>,
  afterRun: Record<string, unknown>,
): {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  rows: Array<{ key: string; label: string; before: number; after: number; delta: number; pct: number | null; verdict: string }>;
};
export declare function renderMetricsMarkdown(history: Record<string, unknown>): string;
