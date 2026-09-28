import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HostResolver } from '@velyric/security';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface ScriptedResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly delayMs?: number;
}

export type Route = (request: RecordedRequest) => ScriptedResponse | undefined;

export interface FakeProvider {
  readonly port: number;
  readonly requests: RecordedRequest[];
  route(handler: Route): void;
  close(): Promise<void>;
}

export const loopbackResolver: HostResolver = () =>
  Promise.resolve([{ address: '127.0.0.1', family: 4 }]);

export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];
  const routes: Route[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const scripted = routes
        .map((route) => route(recorded))
        .find((candidate) => candidate !== undefined) ?? {
        status: 404,
        body: { error: 'not_found' },
      };
      const send = (): void => {
        if (scripted.body === undefined) {
          response.writeHead(scripted.status);
          response.end();
          return;
        }
        response.writeHead(scripted.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(scripted.body));
      };
      if (scripted.delayMs === undefined) {
        send();
      } else {
        setTimeout(send, scripted.delayMs);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    route: (handler) => {
      routes.unshift(handler);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
