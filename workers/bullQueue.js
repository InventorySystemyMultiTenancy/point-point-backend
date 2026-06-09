/**
 * 🚀 WORKER COM BULL QUEUE (Produção)
 *
 * Sistema avançado de filas com Redis para execução de tarefas agendadas.
 *
 * Vantagens sobre node-cron:
 * - ✅ Persistência: Jobs sobrevivem a reinicializações
 * - ✅ Retry automático em caso de falha
 * - ✅ Priorização de jobs
 * - ✅ Dashboard web (Bull Board)
 * - ✅ Distribuído: Múltiplos workers podem processar a mesma fila
 *
 * Uso: Ative definindo REDIS_URL no .env
 */

import Queue from "bull";
import knex from "knex";
import dotenv from "dotenv";

dotenv.config();

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.log(
    "⚠️ REDIS_URL não configurado - use workers/cronJobs.js ao invés deste"
  );
  process.exit(1);
}

// --- Configuração do Banco de Dados ---
const dbConfig = process.env.DATABASE_URL
  ? {
      client: "pg",
      connection: {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      },
    }
  : {
      client: "sqlite3",
      connection: {
        filename: "./data/kiosk.sqlite",
      },
      useNullAsDefault: true,
    };

const db = knex(dbConfig);

const parseJSON = (data) => {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  }
  return data || [];
};

// --- Configuração das Filas ---
const isTruthyDb = (value) =>
  value === true || value === 1 || value === "1" || value === "true";

const getItemProductId = (item) => item?.productId || item?.id || item?.product_id;

const restoreDeductedStock = async (items) => {
  for (const item of Array.isArray(items) ? items : []) {
    const productId = getItemProductId(item);
    const quantity = Number(item?.quantity) || 0;
    if (!productId || quantity <= 0) continue;

    const product = await db("products").where({ id: productId }).first();
    if (!product || product.stock === null || product.stock === undefined) {
      continue;
    }

    await db("products")
      .where({ id: productId })
      .update({ stock: (Number(product.stock) || 0) + quantity });
  }
};

const redisConfig = { redis: REDIS_URL };

const cleanupIntentsQueue = new Queue("cleanup-intents", redisConfig);
const expireOrdersQueue = new Queue("expire-orders", redisConfig);

// --- Processador: Limpar Payment Intents ---
cleanupIntentsQueue.process(async (job) => {
  const { MP_ACCESS_TOKEN, MP_DEVICE_ID } = job.data;

  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    throw new Error("Credenciais MP não configuradas");
  }

  console.log("\n🧹 [QUEUE] Processando limpeza de Payment Intents...");

  const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
  const response = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });

  if (!response.ok) {
    throw new Error(`Erro ao buscar intents: ${response.status}`);
  }

  const data = await response.json();
  const events = data.events || [];

  let cleaned = 0;
  for (const ev of events) {
    const iId = ev.payment_intent_id || ev.id;
    const state = ev.state;

    const shouldClean =
      state === "FINISHED" || state === "CANCELED" || state === "ERROR";

    if (shouldClean) {
      await fetch(`${listUrl}/${iId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      cleaned++;
    }
  }

  console.log(`   ✅ ${cleaned} intent(s) removida(s)\n`);
  return { cleaned, total: events.length };
});

// --- Processador: Expirar Pedidos ---
expireOrdersQueue.process(async (job) => {
  console.log("\n⏰ [QUEUE] Processando expiração de pedidos...");

  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const expiredOrders = await db("orders")
    .where({ paymentStatus: "pending" })
    .where("timestamp", "<", thirtyMinutesAgo)
    .select("*");

  let expired = 0;
  for (const order of expiredOrders) {
    const items = parseJSON(order.items);

    if (isTruthyDb(order.stockDeducted)) {
      await restoreDeductedStock(items);
    }

    // Libera estoque
    for (const item of items) {
      const productId = getItemProductId(item);
      const product = await db("products").where({ id: productId }).first();

      if (product && product.stock !== null && product.stock_reserved > 0) {
        const newReserved = Math.max(0, product.stock_reserved - item.quantity);
        await db("products")
          .where({ id: productId })
          .update({ stock_reserved: newReserved });
      }
    }

    // Marca como expirado
    await db("orders").where({ id: order.id }).update({
      status: "expired",
      paymentStatus: "expired",
      stockDeducted: false,
    });

    expired++;
  }

  console.log(`   ✅ ${expired} pedido(s) expirado(s)\n`);
  return { expired };
});

// --- Agendamento dos Jobs ---
// Cleanup Intents: a cada 2 minutos
cleanupIntentsQueue.add(
  {
    MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
    MP_DEVICE_ID: process.env.MP_DEVICE_ID,
  },
  {
    repeat: { every: 2 * 60 * 1000 }, // 2 minutos
    removeOnComplete: true,
    removeOnFail: false,
  }
);

// Expire Orders: a cada 10 minutos
expireOrdersQueue.add(
  {},
  {
    repeat: { every: 10 * 60 * 1000 }, // 10 minutos
    removeOnComplete: true,
    removeOnFail: false,
  }
);

// --- Event Listeners ---
cleanupIntentsQueue.on("completed", (job, result) => {
  console.log(
    `✅ [QUEUE] Cleanup concluído: ${result.cleaned}/${result.total}`
  );
});

cleanupIntentsQueue.on("failed", (job, err) => {
  console.error(`❌ [QUEUE] Cleanup falhou: ${err.message}`);
});

expireOrdersQueue.on("completed", (job, result) => {
  console.log(`✅ [QUEUE] Expiração concluída: ${result.expired} pedidos`);
});

expireOrdersQueue.on("failed", (job, err) => {
  console.error(`❌ [QUEUE] Expiração falhou: ${err.message}`);
});

// --- Graceful Shutdown ---
const shutdown = async (signal) => {
  console.log(`\n⚠️ Recebido sinal ${signal}. Encerrando queues...`);

  await cleanupIntentsQueue.close();
  await expireOrdersQueue.close();
  await db.destroy();

  console.log("✅ Queues finalizadas com sucesso");
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- Inicialização ---
console.log("🚀 Worker Bull Queue iniciado!");
console.log("📅 Filas ativas:");
console.log("   - cleanup-intents: a cada 2 minutos");
console.log("   - expire-orders: a cada 10 minutos");
console.log("   - Redis: " + REDIS_URL.substring(0, 30) + "...");
console.log("\n✅ Aguardando jobs...\n");

// Health check
setInterval(async () => {
  const intentsWaiting = await cleanupIntentsQueue.getWaitingCount();
  const ordersWaiting = await expireOrdersQueue.getWaitingCount();
  console.log(
    `💓 Health: ${intentsWaiting} intents, ${ordersWaiting} orders aguardando`
  );
}, 60000); // A cada 1 minuto
