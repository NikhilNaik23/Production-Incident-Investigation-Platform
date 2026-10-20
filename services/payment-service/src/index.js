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
const port = Number(process.env.PORT || 3002);
const shouldFail = process.env.PAYMENT_FAIL === "true";
const delayMs = Number(process.env.PAYMENT_DELAY_MS || 0);
const logger = pino({ level: process.env.LOG_LEVEL || "info", base: { service: "payment-service" } });

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
  res.status(200).json({ status: "ok", service: "payment-service" });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.post("/charge", async (req, res) => {
  const { customerId, amount } = req.body ?? {};
  req.log.info({ requestId: req.id, customerId, amount, delayMs }, "payment.charge_requested");

  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));

  if (shouldFail) {
    req.log.error({ requestId: req.id, failureMode: "PAYMENT_FAIL" }, "payment.simulated_failure");
    return res.status(503).json({ error: "Simulated payment provider failure" });
  }

  if (!customerId || typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ error: "Invalid payment request" });
  }

  const payment = { paymentId: randomUUID(), status: "authorized", amount };
  req.log.info({ requestId: req.id, paymentId: payment.paymentId }, "payment.authorized");
  return res.status(200).json(payment);
});

app.listen(port, "0.0.0.0", () => logger.info({ port, delayMs, shouldFail }, "service.started"));
