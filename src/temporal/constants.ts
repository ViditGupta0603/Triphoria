// Hardcoded because the workflow sandbox has no process.env
import type { ActivityOptions } from '@temporalio/common';

export const WORKFLOW_NAME = 'hotelOffersWorkflow';

export const ALL_SUPPLIERS_FAILED = 'ALL_SUPPLIERS_FAILED';

export const INVALID_SUPPLIER_RESPONSE = 'INVALID_SUPPLIER_RESPONSE';

export const SUPPLIER_CLIENT_ERROR = 'SUPPLIER_CLIENT_ERROR';

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
