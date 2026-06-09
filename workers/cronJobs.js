/**
 * 🔧 WORKER DE CRON JOBS
 *
 * Este worker executa tarefas agendadas em background, separado do servidor principal.
 *
 * Benefícios:
 * - ✅ Não bloqueia o servidor HTTP
 * - ✅ Pode ser escalado independentemente
 * - ✅ Reinicia automaticamente em caso de erro
 * - ✅ Logs isolados e estruturados
 */

import cron from "node-cron";
import knex from "knex";
import dotenv from "dotenv";

dotenv.config();

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

// Utilitário para parsear JSON
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

const isTruthyDb = (value) =>
  value === true || value === 1 || value === "1" || value === "true";

const getItemProductId = (item) => item?.productId || item?.id || item?.product_id;

const getItemQuantity = (item, fallback = 1) => {
  const quantity = Number(
    item?.quantity ?? item?.quantidade ?? item?.qtd ?? item?.qty ?? fallback,
  );

  return Number.isFinite(quantity) && quantity > 0 ? quantity : fallback;
};

const restoreDeductedStock = async (items) => {
  for (const item of Array.isArray(items) ? items : []) {
    const productId = getItemProductId(item);
    const quantity = getItemQuantity(item, 0);
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

const cleanupExpiredOutsourcedServices = async () => {
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const expiredServices = await db("outsourced_services")
    .where("created_at", "<", cutoff)
    .select("id");

  if (expiredServices.length === 0) return 0;

  const expiredIds = expiredServices.map((service) => service.id);
  await db("outsourced_service_deliveries")
    .whereIn("service_id", expiredIds)
    .del();
  await db("outsourced_services").whereIn("id", expiredIds).del();

  return expiredIds.length;
};

// --- CRON JOB 1: Limpar Payment Intents da Maquininha (a cada 2 minutos) ---
const cleanupPointIntents = cron.schedule("*/2 * * * *", async () => {
  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const MP_DEVICE_ID = process.env.MP_DEVICE_ID;

  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) return;

  try {
    console.log("\n🧹 [WORKER] Iniciando limpeza de Payment Intents...");

    const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    const response = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (response.ok) {
      const data = await response.json();
      const events = data.events || [];

      if (events.length > 0) {
        console.log(`   📋 Encontradas ${events.length} intent(s) pendentes`);

        let cleaned = 0;
        for (const ev of events) {
          const iId = ev.payment_intent_id || ev.id;
          const state = ev.state;

          const shouldClean =
            state === "FINISHED" || state === "CANCELED" || state === "ERROR";

          if (shouldClean) {
            try {
              await fetch(`${listUrl}/${iId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
              });
              console.log(`   ✅ Intent ${iId} (${state}) removida`);
              cleaned++;
            } catch (e) {
              console.log(`   ⚠️ Erro ao remover ${iId}: ${e.message}`);
            }
          }
        }

        console.log(`   🎉 Total de ${cleaned} intent(s) removida(s)\n`);
      } else {
        console.log("   ✨ Nenhuma intent pendente para limpar\n");
      }
    }
  } catch (error) {
    console.error(`   ❌ Erro na limpeza: ${error.message}\n`);
  }
});

// --- CRON JOB 2: Expirar Pedidos Pendentes (a cada 10 minutos) ---
const expireOrders = cron.schedule("*/10 * * * *", async () => {
  try {
    console.log("\n⏰ [WORKER] Verificando pedidos expirados...");

    const thirtyMinutesAgo = new Date(
      Date.now() - 30 * 60 * 1000
    ).toISOString();

    const expiredOrders = await db("orders")
      .where({ paymentStatus: "pending" })
      .where("timestamp", "<", thirtyMinutesAgo)
      .select("*");

    if (expiredOrders.length > 0) {
      console.log(
        `   📋 ${expiredOrders.length} pedido(s) expirado(s) encontrado(s)`
      );

      for (const order of expiredOrders) {
        const items = parseJSON(order.items);

        if (isTruthyDb(order.stockDeducted)) {
          await restoreDeductedStock(items);
        }

        // Libera estoque reservado
        for (const item of items) {
          const productId = getItemProductId(item);
          const quantity = getItemQuantity(item, 0);
          const product = await db("products").where({ id: productId }).first();

          if (product && product.stock !== null && product.stock_reserved > 0) {
            const newReserved = Math.max(
              0,
              product.stock_reserved - quantity
            );

            await db("products")
              .where({ id: productId })
              .update({ stock_reserved: newReserved });

            console.log(
              `   ↩️ ${item.name}: liberado ${quantity} unidade(s) (${product.stock_reserved} → ${newReserved})`
            );
          }
        }

        // Marca pedido como expirado
        await db("orders").where({ id: order.id }).update({
          status: "expired",
          paymentStatus: "expired",
          stockDeducted: false,
        });

        console.log(`   ❌ Pedido ${order.id} marcado como expirado`);
      }

      console.log(
        `   🎉 Total de ${expiredOrders.length} pedido(s) expirado(s)\n`
      );
    } else {
      console.log("   ✨ Nenhum pedido expirado\n");
    }
  } catch (error) {
    console.error(`   ❌ Erro ao expirar pedidos: ${error.message}\n`);
  }
});

// --- CRON JOB 3: Limpar Cache Map em Memória (a cada 1 hora) ---
// Nota: Esse job só é necessário se NÃO estiver usando Redis
const cleanupCache = cron.schedule("0 * * * *", () => {
  // Este job é executado no servidor principal agora, pois precisa acessar o Map
  // Mantido aqui apenas para referência
  console.log(
    "\nℹ️ [WORKER] Limpeza de cache movida para o servidor principal\n"
  );
});

// --- CRON JOB 4: Remover servicos terceirizados com mais de 60 dias ---
const cleanupOutsourcedServices = cron.schedule("0 3 * * *", async () => {
  try {
    console.log("\n[WORKER] Limpando servicos terceirizados antigos...");
    const removed = await cleanupExpiredOutsourcedServices();
    console.log(`   ${removed} servico(s) removido(s)\n`);
  } catch (error) {
    console.error(
      `   Erro ao limpar servicos terceirizados antigos: ${error.message}\n`
    );
  }
});

// --- Graceful Shutdown ---
const shutdown = async (signal) => {
  console.log(`\n⚠️ Recebido sinal ${signal}. Encerrando workers...`);

  cleanupPointIntents.stop();
  expireOrders.stop();
  cleanupCache.stop();
  cleanupOutsourcedServices.stop();

  await db.destroy();

  console.log("✅ Workers finalizados com sucesso");
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- Inicialização ---
console.log("🚀 Worker de Cron Jobs iniciado!");
console.log("📅 Jobs agendados:");
console.log("   - Limpeza de Payment Intents: a cada 2 minutos");
console.log("   - Expiração de Pedidos: a cada 10 minutos");
console.log("   - Limpeza de Cache: a cada 1 hora (no servidor principal)");
console.log("   - Limpeza de servicos terceirizados: diariamente as 03:00");
console.log("\n✅ Aguardando execução dos jobs...\n");

// Inicia os jobs
cleanupPointIntents.start();
expireOrders.start();
cleanupOutsourcedServices.start();

// Mantém o processo ativo
process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error);
  // Não encerra o processo - workers devem ser resilientes
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada não tratada:", reason);
  // Não encerra o processo - workers devem ser resilientes
});
