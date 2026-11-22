import { ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import type { HotelOffersWorkflowInput, HotelOffersWorkflowResult } from '../types';
import type { Activities } from './activities';
import { ALL_SUPPLIERS_FAILED, CACHE_ACTIVITY_OPTIONS, SUPPLIER_ACTIVITY_OPTIONS } from './constants';
import { collectBestOffers } from './orchestrate';

const { fetchSupplierHotels } = proxyActivities<Activities>(SUPPLIER_ACTIVITY_OPTIONS);
const { cacheHotels } = proxyActivities<Activities>(CACHE_ACTIVITY_OPTIONS);

export async function hotelOffersWorkflow(
  input: HotelOffersWorkflowInput,
): Promise<HotelOffersWorkflowResult> {
  return collectBestOffers(input.city, {
    fetchSupplierHotels,
    cacheHotels,
    allSuppliersFailed: (message, failures) =>
      ApplicationFailure.nonRetryable(message, ALL_SUPPLIERS_FAILED, { failures }),
    log: {
      info: (message, meta) => log.info(message, { requestId: input.requestId, ...meta }),
      warn: (message, meta) => log.warn(message, { requestId: input.requestId, ...meta }),
      error: (message, meta) => log.error(message, { requestId: input.requestId, ...meta }),
    },
  });
}
