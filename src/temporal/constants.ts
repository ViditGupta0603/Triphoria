/**
 * Values used inside the workflow sandbox. The sandbox has no `process.env`,
 * so these are constants rather than config.
 */
import type { ActivityOptions } from '@temporalio/common';

export const WORKFLOW_NAME = 'hotelOffersWorkflow';

/** Error type thrown by the workflow when no supplier returned data. */
export const ALL_SUPPLIERS_FAILED = 'ALL_SUPPLIERS_FAILED';

/** Error type for supplier payloads that fail validation (not retried). */
export const INVALID_SUPPLIER_RESPONSE = 'INVALID_SUPPLIER_RESPONSE';

/** Error type for supplier 4xx responses (not retried). */
export const SUPPLIER_CLIENT_ERROR = 'SUPPLIER_CLIENT_ERROR';

/** Error type for supplier 5xx / network errors (retried). */
export const SUPPLIER_UNAVAILABLE = 'SUPPLIER_UNAVAILABLE';

export const SUPPLIER_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '200 milliseconds',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
    maximumAttempts: 3,
    nonRetryableErrorTypes: [INVALID_SUPPLIER_RESPONSE, SUPPLIER_CLIENT_ERROR],
  },
};

export const CACHE_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '200 milliseconds',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
    maximumAttempts: 5,
  },
};

export const WORKFLOW_EXECUTION_TIMEOUT = '30 seconds';
