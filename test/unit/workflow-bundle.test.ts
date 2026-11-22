import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

/**
 * Bundles the workflow the same way the worker does. This fails if the
 * workflow (or anything it imports) uses Node APIs or other modules that are
 * not allowed in Temporal's deterministic sandbox.
 */
describe('workflow bundle', () => {
  it('bundles for the Temporal sandbox and exports hotelOffersWorkflow', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: path.resolve(__dirname, '../../src/temporal/workflows.ts'),
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} },
    });
    expect(code).toContain('hotelOffersWorkflow');
    expect(code).not.toMatch(/require\(["'](ioredis|express|pino)["']\)/);
  }, 120_000);
});
