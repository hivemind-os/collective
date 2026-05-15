import pino from 'pino';

const logger = pino({ name: '@agentic-mesh/daemon:audit' });

export type AuditEvent =
  | {
      event: 'app_connected';
      appName: string;
      appPid: number;
      connectionId: string;
    }
  | {
      event: 'app_disconnected';
      appName: string;
      connectionId: string;
      duration: number;
    }
  | {
      event: 'tool_call';
      appName: string;
      tool: string;
      taskId?: string;
    }
  | {
      event: 'spending';
      appName: string;
      amount: string;
      taskId: string;
    };

type AuditListener = (event: AuditEvent) => void;

const listeners = new Set<AuditListener>();

export function logAuditEvent(event: AuditEvent): void {
  logger.info(event);
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeAuditEvents(listener: AuditListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
