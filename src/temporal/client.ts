import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { config } from '../config';
import { logger } from '../logger';
import type { HotelOffersWorkflowResult } from '../types';
import { WORKFLOW_EXECUTION_TIMEOUT, WORKFLOW_NAME } from './constants';
import { connectWithRetry } from './connection';

let clientPromise: Promise<{ client: Client; connection: Connection }> | undefined;

const getTemporal = () => {
  clientPromise ??= connectWithRetry('Temporal', () =>
    Connection.connect({ address: config.TEMPORAL_ADDRESS }),
  )
    .then((connection) => {
      logger.info({ address: config.TEMPORAL_ADDRESS }, 'Connected to Temporal');
      return { connection, client: new Client({ connection, namespace: config.TEMPORAL_NAMESPACE }) };
    })
    .catch((err: unknown) => {
      clientPromise = undefined;
      throw err;
    });
  return clientPromise;
};

export const getTemporalClient = async (): Promise<Client> => (await getTemporal()).client;

export interface HotelOffersRunner {
  run(city: string, requestId?: string): Promise<HotelOffersWorkflowResult>;
}

export const temporalRunner: HotelOffersRunner = {
  async run(city, requestId) {
    const client = await getTemporalClient();
    const workflowId = `hotel-offers-${city.replace(/\s+/g, '-')}-${randomUUID()}`;
    logger.info({ workflowId, city, requestId }, 'Starting workflow');

    return client.workflow.execute(WORKFLOW_NAME, {
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      workflowId,
      args: [{ city, requestId }],
      workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      memo: requestId ? { requestId } : undefined,
    }) as Promise<HotelOffersWorkflowResult>;
  },
};

export const checkTemporal = async (): Promise<void> => {
  const { connection } = await getTemporal();
  await connection.healthService.check({});
};

export const closeTemporalClient = async (): Promise<void> => {
  if (!clientPromise) return;
  const temporal = await clientPromise.catch(() => undefined);
  await temporal?.connection.close();
  clientPromise = undefined;
};
