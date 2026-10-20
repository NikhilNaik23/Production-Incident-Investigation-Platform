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
const port = Number(process.env.PORT || 3001);
const paymentUrl = process.env.PAYMENT_URL || "http://localhost:3002";
const inventoryUrl = process.env.INVENTORY_URL || "http://localhost:3003";
const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 2500);
const logger = pino({ level: process.env.LOG_LEVEL || "info", base: { service: "order-service" } });

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
  res.status(200).json({ status: "ok", service: "order-service" });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.post("/orders", async (req, res) => {
  const { customerId, sku, quantity, amount } = req.body ?? {};
  if (!customerId || !sku || !Number.isInteger(quantity) || quantity < 1 ||
      typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({
      error: "Invalid order. Required: customerId, sku, positive integer quantity, positive numeric amount."
    });
  }

  const requestId = req.id;
  req.log.info({ requestId, customerId, sku, quantity, amount }, "order.received");

  try {
    const inventoryResponse = await fetch(`${inventoryUrl}/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ sku, quantity }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!inventoryResponse.ok) {
      const body = await inventoryResponse.text();
      req.log.error({ requestId, dependency: "inventory-service", statusCode: inventoryResponse.status, body }, "order.inventory_failed");
      return res.status(502).json({ error: "Inventory dependency failed", requestId });
    }

    const inventory = await inventoryResponse.json();

    const paymentResponse = await fetch(`${paymentUrl}/charge`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ customerId, amount }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!paymentResponse.ok) {
      const body = await paymentResponse.text();
      req.log.error({ requestId, dependency: "payment-service", statusCode: paymentResponse.status, body }, "order.payment_failed");
      return res.status(502).json({ error: "Payment dependency failed", requestId });
    }

    const payment = await paymentResponse.json();
    const order = {
      orderId: randomUUID(),
      customerId,
      sku,
      quantity,
      amount,
      inventoryReservationId: inventory.reservationId,
      paymentId: payment.paymentId,
      status: "confirmed"
    };

    req.log.info({ requestId, orderId: order.orderId, status: order.status }, "order.confirmed");
    return res.status(201).json(order);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    req.log.error({
      requestId,
      dependency: error?.cause?.hostname || "downstream-service",
      errorName: error?.name,
      errorMessage: error?.message,
      timedOut
    }, "order.downstream_request_failed");
    return res.status(504).json({
      error: timedOut ? "Downstream service timed out" : "Downstream service unavailable",
      requestId
    });
  }
});

app.listen(port, "0.0.0.0", () => logger.info({ port }, "service.started"));
