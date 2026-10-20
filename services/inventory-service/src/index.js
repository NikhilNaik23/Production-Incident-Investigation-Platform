import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import {
  register,
  httpRequests,
  httpDuration,
} from './metrics.js';

const app = express();
const port = Number(process.env.PORT || 3003);
const shouldFail = process.env.INVENTORY_FAIL === "true";
const delayMs = Number(process.env.INVENTORY_DELAY_MS || 0);
const logger = pino({ level: process.env.LOG_LEVEL || "info", base: { service: "inventory-service" } });

app.use(express.json());
app.use(pinoHttp({
  logger,
  genReqId(req, res) {
    const supplied = req.headers["x-request-id"];
    const requestId = typeof supplied === "string" && supplied.length < 128 ? supplied : randomUUID();
    res.setHeader("x-request-id", requestId);
    return requestId;
  },
  customProps(req) { return { requestId: req.id }; }
}));
app.use((req, res, next) => {
  if (req.path === '/metrics') {
  return next();
}
  const endTimer = httpDuration.startTimer();

  res.on('finish', () => {
    const route = req.route?.path || req.path;

    httpRequests.inc({
      method: req.method,
      route,
      status_code: String(res.statusCode),
    });

    endTimer({
      method: req.method,
      route,
    });
  });

  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "inventory-service" });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.post("/reserve", async (req, res) => {
  const { sku, quantity } = req.body ?? {};
  req.log.info({ requestId: req.id, sku, quantity, delayMs }, "inventory.reserve_requested");

  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));

  if (shouldFail) {
    req.log.error({ requestId: req.id, failureMode: "INVENTORY_FAIL" }, "inventory.simulated_failure");
    return res.status(503).json({ error: "Simulated inventory failure" });
  }

  if (!sku || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: "Invalid inventory request" });
  }

  const reservation = { reservationId: randomUUID(), sku, quantity, status: "reserved" };
  req.log.info({ requestId: req.id, reservationId: reservation.reservationId }, "inventory.reserved");
  return res.status(200).json(reservation);
});

app.listen(port, "0.0.0.0", () => logger.info({ port, delayMs, shouldFail }, "service.started"));
