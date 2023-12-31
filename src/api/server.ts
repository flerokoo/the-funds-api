import express, { Response } from 'express';
import { ApplicationServices } from '../services/init-services.js';
import { ApplicationError, HTTP_NOT_FOUND } from '../utils/errors.js';
import https from 'node:https';
import http from 'node:http';
import { IGracefulShutdownHandler } from '../utils/graceful-shutdown.js';
import { logger } from '../utils/logger.js';
import { configureExpress } from './configure-express-app.js';
import config from '../config.js';
import { readFileSync } from 'node:fs';
import { createWebSocketServer } from './websocket/create-websocket-server.js';
import { ControllerCtor, IController } from './controllers/index.js';
import { JwtTokenValidator } from '../utils/jwt-validator.js';

export type ApiDependencies = ApplicationServices;
export type Protocol = 'http' | 'https';
export type AnyServer = http.Server | https.Server;
const httpToWs = {
  http: 'ws',
  https: 'wss'
};

export async function initServer(
  controllers: IController[],
  jwtValidator: JwtTokenValidator,
  gsHandler: IGracefulShutdownHandler
) {
  const app = express();
  configureExpress(app, controllers, jwtValidator, gsHandler);

  const protocolsLaunchers = {
    http: createHttpServer,
    https: createHttpsServer
  };

  const protocols: Protocol[] = Object.keys(protocolsLaunchers) as unknown as Protocol[];

  const servers: Map<Protocol, AnyServer> = protocols
    .filter((_) => config[_].enabled)
    .reduce((servers, protocol: Protocol) => {
      const server = protocolsLaunchers[protocol](app);
      shutdownGracefully(server, gsHandler);
      servers.set(protocol, server);
      if (config.websocket.enabled) {
        const wss = createWebSocketServer(server, controllers, jwtValidator);
        servers.set(httpToWs[protocol], wss);
      }
      return servers;
    }, new Map());

  const promises = Array.from(['http', 'https'] as const).map((_) =>
    listen(getEnvPort(_) ?? config[_].port, servers.get(_)!)
  );

  return Promise.all(promises).then(() => servers);
}

function listen(port: number, server: AnyServer) {
  return new Promise((resolve: (a?: unknown) => void) => {
    server.listen(port, () => {
      logger.info(`listening on port ${port}`);
      resolve(server);
    });
  });
}

function createHttpServer(app: express.Application) {
  return http.createServer(app);
}

function createHttpsServer(app: express.Application) {
  const opts = {
    cert: readFileSync(config.https.certPath),
    key: readFileSync(config.https.keyPath)
  };
  return https.createServer(opts, app);
}

function shutdownGracefully(
  server: http.Server | https.Server,
  handler: IGracefulShutdownHandler
) {
  handler.onShutdown(() => {
    logger.info('closing server...');
    return new Promise((resolve) => {
      logger.info('server closed');
      server.close(() => resolve());
    });
  });
}

function getEnvPort(protocol: Protocol) {
  const envName = protocol.toUpperCase() + '_PORT';
  const port = parseInt(process.env[envName]!);
  return isNaN(port) ? null : port;
}

export function handleError(err: Error, res: Response) {
  const status = err instanceof ApplicationError ? err.status : HTTP_NOT_FOUND;
  const payload = err instanceof ApplicationError ? err.payload : undefined;
  const message = err.message ?? err.name ?? 'Unknown error';
  res.status(status).json({ status: 'error', message, payload });
  logger.error(message);
}
