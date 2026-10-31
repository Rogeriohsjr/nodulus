import type { BinaryLike } from "node:crypto";

export function digest(value: BinaryLike): string;
export function fileHash(file: string): string | null;
export function confinedPath(root: string, relative: string): string;

export type FileChange = { path: string; content: string };
export type ApplyFileReceipt = {
  schemaVersion: 1;
  startedAt: string;
  endedAt: string;
  path: string;
  applied: boolean;
  expectedHash: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  error: unknown;
  receiptPath: string;
};

export function applyFile(options: {
  root: string;
  allowedPaths: string[];
  expectedHash: string | null;
  change: FileChange;
  receiptDirectory: string;
}): ApplyFileReceipt;

export type CheckRequest = {
  id: string;
  executable: string;
  args: string[];
  timeoutMs?: number;
};
export type CheckResult = {
  id: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
};

export function runCheck(root: string, check: CheckRequest): CheckResult;
