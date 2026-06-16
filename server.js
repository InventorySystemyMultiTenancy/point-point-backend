// ...existing code...
// ...existing code...
// ...existing code...
// --- Middlewares de Autenticação e Autorização ---

// Atualizar informações do usuário (incluindo senha)

import { sendOrderPdfEmail } from "./services/orderPdfEmail.js";
import express from "express";
import fs from "fs/promises";
import path from "path";
import cors from "cors";
import OpenAI from "openai";
import knex from "knex";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
import { MercadoPagoConfig, Payment, Preference } from "mercadopago";
import paymentRoutes from "./routes/payment.js";
import * as paymentService from "./services/paymentService.js";
import PDFDocument from "pdfkit";
import superAdminRoutes from "./routes/superadmin.js";

// Corrige importação para compatibilidade CommonJS/ESM
// Se der erro, tente:
// import superAdminRoutes = require('./routes/superadmin.js');
// ou
// import * as superAdminRoutes from './routes/superadmin.js';

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://point-point-frontend.vercel.app",
  "https://primeplush.vercel.app",
  "https://primeplush.com.br",
  "https://pointpoint.selfmachine.com.br",
  "https://www.pointpoint.selfmachine.com.br",
  process.env.FRONTEND_URL,
].filter(Boolean);

const isAllowedVercelPreviewOrigin = (origin) => {
  if (!origin) return false;

  try {
    const { hostname, protocol } = new URL(origin);
    return (
      protocol === "https:" &&
      hostname.endsWith(".vercel.app") &&
      hostname.startsWith("point-point-frontend")
    );
  } catch (e) {
    return false;
  }
};

const corsOptions = {
  origin(origin, callback) {
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      isAllowedVercelPreviewOrigin(origin)
    ) {
      return callback(null, true);
    }

    console.warn(`CORS bloqueado para origem: ${origin}`);
    return callback(new Error(`CORS bloqueado para origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Super-Admin-Password"],
  credentials: true,
};

// Configuração CORS para permitir frontend local e produção
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Centraliza as rotas de Super Admin
app.use("/api", superAdminRoutes);

// Endpoint: contagem de pedidos dos últimos 30 dias
app.get("/api/orders/last30days-count", async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const count = await db("orders")
      .where("timestamp", ">=", thirtyDaysAgo.toISOString())
      .count({ total: "id" })
      .first();
    res.json({ count: Number(count.total) || 0 });
  } catch (err) {
    console.error("Erro ao buscar contagem dos últimos 30 dias:", err);
    res
      .status(500)
      .json({ error: "Erro ao buscar contagem dos últimos 30 dias" });
  }
});
// --- Configurações ---
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_DEVICE_ID = process.env.MP_DEVICE_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KITCHEN_PASSWORD = process.env.KITCHEN_PASSWORD;
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const REDIS_URL = process.env.REDIS_URL;

// Inicializa SDK do Mercado Pago
let mercadopago = null;
let paymentClient = null;
let preferenceClient = null;

if (MP_ACCESS_TOKEN) {
  const client = new MercadoPagoConfig({
    accessToken: MP_ACCESS_TOKEN,
    options: { timeout: 5000 },
  });
  mercadopago = client;
  paymentClient = new Payment(client);
  preferenceClient = new Preference(client);
  console.log("✅ SDK MercadoPago inicializado com sucesso!");
} else {
  console.warn("⚠️ MP_ACCESS_TOKEN não configurado - SDK desabilitado");
}

// --- Banco de Dados ---
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
        filename: path.join(process.cwd(), "data", "kiosk.sqlite"),
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

const parseSeparationChecklist = (data) => {
  const parsed = parseJSON(data);
  return Array.isArray(parsed) || (parsed && typeof parsed === "object")
    ? parsed
    : [];
};

const normalizeOrderResponse = (order) => ({
  ...order,
  items: parseJSON(order.items),
  total: parseFloat(order.total),
  separationChecklist: parseSeparationChecklist(order.separationChecklist),
  entregueCliente: isTruthyDb(order.entregueCliente),
});

const BACKORDER_NOTICE =
  "Produto sob encomenda: prazo minimo de espera de 7 dias uteis.";

const getStockAvailable = (product) => {
  if (!product) return 0;
  return (Number(product.stock) || 0) - (Number(product.stock_reserved) || 0);
};

const getBackorderMeta = (product, quantity = 1) => {
  const stockAvailable = getStockAvailable(product);
  const requestedQuantity = Math.max(0, Number(quantity) || 1);
  const backorderQuantity =
    stockAvailable <= 0
      ? requestedQuantity
      : Math.max(0, requestedQuantity - stockAvailable);

  return {
    stockAvailable,
    isBackorder: backorderQuantity > 0,
    backorderQuantity,
    backorderNotice: backorderQuantity > 0 ? BACKORDER_NOTICE : null,
  };
};

const isTruthyDb = (value) =>
  value === true || value === 1 || value === "1" || value === "true";

const IMPORTED_CATEGORY_NAME = "importados";

const normalizeCategoryName = (category) =>
  String(category || "").trim().toLowerCase();

const makeCategoryIdFromName = (name) =>
  `cat_${normalizeCategoryName(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;

const isImportedProduct = (product) =>
  normalizeCategoryName(product?.category) === IMPORTED_CATEGORY_NAME;

const isHiddenProduct = (product) => isTruthyDb(product?.hidden);

const normalizeStringList = (value) => {
  const parsed = typeof value === "string" ? parseJSON(value) : value;
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed
        .map((item) => {
          if (typeof item === "string") return item;
          return item?.id || item?.userId || item?.clientId || "";
        })
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  ];
};

const getProductVisibilityMap = async (productIds = null, query = db) => {
  let visibilityQuery = query("product_visible_users").select(
    "productId",
    "userId",
  );

  if (Array.isArray(productIds) && productIds.length > 0) {
    visibilityQuery = visibilityQuery.whereIn(
      "productId",
      [...new Set(productIds.map(String))],
    );
  }

  const rows = await visibilityQuery;
  const map = new Map();
  rows.forEach((row) => {
    const productId = String(row.productId);
    if (!map.has(productId)) map.set(productId, new Set());
    map.get(productId).add(String(row.userId));
  });
  return map;
};

const getProductVisibilityPayloadMap = async (productIds = null, query = db) => {
  const visibilityMap = await getProductVisibilityMap(productIds, query);
  return new Map(
    [...visibilityMap.entries()].map(([productId, userIds]) => [
      productId,
      [...userIds],
    ]),
  );
};

const filterCatalogProducts = (
  products,
  {
    hasFullAccess = false,
    isAdminCatalog = false,
    userId = null,
    visibilityMap = new Map(),
  } = {},
) =>
  products.filter((product) => {
    if (!hasFullAccess && isImportedProduct(product)) return false;
    if (!isHiddenProduct(product)) return true;
    if (isAdminCatalog) return true;
    if (!userId) return false;
    return visibilityMap.get(String(product.id))?.has(String(userId)) || false;
  });

const getBearerToken = (req) => {
  const authHeader = req.headers["authorization"];
  return authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;
};

const hasAdminCatalogAccess = (req) => {
  const token = getBearerToken(req);
  if (!token || !JWT_SECRET) return false;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload?.role === "admin" || payload?.role === "superadmin";
  } catch (e) {
    return false;
  }
};

const resolveCatalogContext = async (req) => {
  const isAdminCatalog = hasAdminCatalogAccess(req);
  const userId = resolveRequestUserId(req);

  if (isAdminCatalog) {
    return { isAdminCatalog, hasFullAccess: true, userId };
  }

  if (!userId) {
    return { isAdminCatalog, hasFullAccess: false, userId: null };
  }

  const user = await db("users").where({ id: String(userId) }).first();
  return {
    isAdminCatalog,
    hasFullAccess: userHasFullAccess(user),
    userId,
  };
};

const userHasFullAccess = (user) => isTruthyDb(user?.fullAccess);

const resolveCatalogFullAccess = async (req) =>
  (await resolveCatalogContext(req)).hasFullAccess;

const resolveRequestUserId = (req) => {
  const token = getBearerToken(req);
  let tokenUserId = null;
  if (token && JWT_SECRET) {
    try {
      tokenUserId = jwt.verify(token, JWT_SECRET)?.userId;
    } catch (e) {
      tokenUserId = null;
    }
  }

  return tokenUserId || req.query.userId || req.headers["x-user-id"] || null;
};

const normalizePriceValue = (value) => {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
};

const getUserProductPriceMap = async (userId, productIds = null, query = db) => {
  if (!userId) return new Map();

  let pricesQuery = query("user_product_prices").where({
    userId: String(userId),
  });

  if (Array.isArray(productIds) && productIds.length > 0) {
    pricesQuery = pricesQuery.whereIn(
      "productId",
      [...new Set(productIds.map(String))],
    );
  }

  const rows = await pricesQuery;
  return new Map(
    rows.map((row) => [
      String(row.productId),
      {
        customPrice: Number(row.price),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    ]),
  );
};

const applyUserProductPrices = async (products, userId) => {
  if (!userId || !Array.isArray(products) || products.length === 0) {
    return products;
  }

  const priceMap = await getUserProductPriceMap(
    userId,
    products.map((product) => product.id),
  );

  return products.map((product) => {
    const custom = priceMap.get(String(product.id));
    if (!custom) return product;

    return {
      ...product,
      basePrice: product.price,
      price: custom.customPrice,
      customPrice: custom.customPrice,
      hasCustomPrice: true,
    };
  });
};

const getUserProductPricesPayload = async (userId) => {
  const user = await db("users").where({ id: String(userId) }).first();
  if (!user) {
    throw Object.assign(new Error("Usuário não encontrado"), {
      statusCode: 404,
    });
  }

  const products = await db("products").select("*").orderBy("name", "asc");
  const priceMap = await getUserProductPriceMap(userId);
  const visibilityPayloadMap = await getProductVisibilityPayloadMap(
    products.map((product) => product.id),
  );

  return {
    user: normalizeUserResponse(user),
    products: products.map((product) => {
      const custom = priceMap.get(String(product.id));
      return normalizeProductResponse({
        ...product,
        visibleUserIds: visibilityPayloadMap.get(String(product.id)) || [],
        basePrice: product.price,
        customPrice: custom?.customPrice ?? null,
        hasCustomPrice: !!custom,
      });
    }),
    customPrices: [...priceMap.entries()].map(([productId, custom]) => ({
      productId,
      price: custom.customPrice,
      created_at: custom.created_at,
      updated_at: custom.updated_at,
    })),
  };
};

const normalizeUserResponse = (user) => ({
  ...user,
  historico: parseJSON(user?.historico),
  fullAccess: userHasFullAccess(user),
  monthlyPayment: isTruthyDb(user?.monthlyPayment),
});

const userHasMonthlyPayment = (user) => isTruthyDb(user?.monthlyPayment);

const toYearMonth = (date = new Date()) => {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
};

const getMonthRange = (yearMonth = toYearMonth()) => {
  const normalized = String(yearMonth || "").match(/^(\d{4})-(\d{2})$/);
  if (!normalized) {
    throw validationError("Mês inválido. Use o formato YYYY-MM.");
  }

  const year = Number(normalized[1]);
  const monthIndex = Number(normalized[2]) - 1;
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 1);

  return {
    yearMonth: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
};

const getPreviousYearMonth = () => {
  const now = new Date();
  return toYearMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
};

const isMonthlyDeferredPayment = (paymentType, paymentMethod) =>
  String(paymentType || "").toLowerCase() === "presencial" &&
  ["a_prazo", "à_prazo", "a prazo", "à prazo", "aprazo"].includes(
    String(paymentMethod || "")
      .trim()
      .toLowerCase(),
  );

const DELIVERY_METHODS = {
  carrier: {
    value: "carrier",
    label: "Transportadora",
    requiresCarrier: true,
  },
  pickup: {
    value: "pickup",
    label: "Retirada no local",
    requiresCarrier: false,
  },
  in_person: {
    value: "in_person",
    label: "Presencial",
    requiresCarrier: false,
  },
  contact: {
    value: "contact",
    label: "Entrar em contato",
    requiresCarrier: false,
  },
};

const DELIVERY_METHOD_ALIASES = {
  transportadora: "carrier",
  carrier: "carrier",
  retirada: "pickup",
  retirada_local: "pickup",
  "retirada no local": "pickup",
  pickup: "pickup",
  presencial: "in_person",
  in_person: "in_person",
  local: "in_person",
  contato: "contact",
  entrar_contato: "contact",
  "entrar em contato": "contact",
  contact: "contact",
};

const normalizeDeliveryMethod = (value) =>
  DELIVERY_METHOD_ALIASES[String(value || "").trim().toLowerCase()] || "contact";

const getDeliveryMethodMeta = (value) => {
  const normalized = normalizeDeliveryMethod(value);
  return DELIVERY_METHODS[normalized] || DELIVERY_METHODS.contact;
};

const normalizeShippingCarrier = (carrier) =>
  carrier
    ? {
        ...carrier,
        active: isTruthyDb(carrier.active),
        trackingUrl: carrier.trackingUrl || null,
      }
    : null;

const buildOrderDeliveryPayload = (order, carrier = null) => {
  const method = getDeliveryMethodMeta(order?.deliveryMethod);
  const normalizedCarrier = normalizeShippingCarrier(carrier);
  const trackingUrl =
    method.value === "carrier" && normalizedCarrier?.trackingUrl
      ? normalizedCarrier.trackingUrl
      : null;

  return {
    deliveryMethod: method.value,
    deliveryMethodLabel: method.label,
    deliveryRequiresCarrier: method.requiresCarrier,
    carrierId: order?.carrierId || null,
    shippingCarrier: normalizedCarrier,
    trackingUrl,
    trackingMessage: trackingUrl
      ? "Acompanhar entrega"
      : "Entrar em contato para rastrear",
  };
};

const enrichOrdersWithDelivery = async (orders) => {
  const orderList = Array.isArray(orders) ? orders : [];
  const carrierIds = [
    ...new Set(orderList.map((order) => order.carrierId).filter(Boolean)),
  ];
  const carriersById = new Map();

  if (carrierIds.length > 0) {
    const carriers = await db("shipping_carriers").whereIn("id", carrierIds);
    carriers.forEach((carrier) => carriersById.set(carrier.id, carrier));
  }

  return orderList.map((order) => ({
    ...order,
    ...buildOrderDeliveryPayload(order, carriersById.get(order.carrierId)),
  }));
};

const getItemProductId = (item) => item?.productId || item?.id || item?.product_id;

const getItemQuantity = (item, fallback = 1) => {
  const quantity = Number(
    item?.quantity ?? item?.quantidade ?? item?.qtd ?? item?.qty ?? fallback,
  );

  return Number.isFinite(quantity) && quantity > 0 ? quantity : fallback;
};

const adjustStockForOrderItems = async (query, items, direction = -1) => {
  const changedItems = [];

  for (const item of Array.isArray(items) ? items : []) {
    const productId = getItemProductId(item);
    const quantity = getItemQuantity(item, 0);

    if (!productId || quantity <= 0) {
      continue;
    }

    const product = await query("products").where({ id: productId }).first();
    if (!product) {
      continue;
    }

    const currentStock = Number(product.stock) || 0;
    const nextStock = currentStock + direction * quantity;

    await query("products").where({ id: productId }).update({
      stock: nextStock,
    });

    changedItems.push({
      productId,
      name: item?.name || product.name || "Produto",
      quantity,
      stockBefore: currentStock,
      stockAfter: nextStock,
    });
  }

  return changedItems;
};

const normalizeProductResponse = (product) => {
  const parsedImages = parseJSON(product.images);
  const normalizedImages =
    Array.isArray(parsedImages) && parsedImages.length > 0
      ? parsedImages
      : product.imageUrl
        ? [product.imageUrl]
        : [];
  const stockAvailable = getStockAvailable(product);

  return {
    ...product,
    hidden: isHiddenProduct(product),
    visibleUserIds: normalizeStringList(product.visibleUserIds),
    price: product.price !== undefined ? parseFloat(product.price) : 0,
    basePrice:
      product.basePrice !== undefined && product.basePrice !== null
        ? parseFloat(product.basePrice)
        : product.price !== undefined
          ? parseFloat(product.price)
          : 0,
    customPrice:
      product.customPrice !== undefined && product.customPrice !== null
        ? parseFloat(product.customPrice)
        : null,
    hasCustomPrice: isTruthyDb(product.hasCustomPrice),
    priceRaw:
      product.priceRaw !== undefined && product.priceRaw !== null
        ? parseFloat(product.priceRaw)
        : 0,
    imageUrl: normalizedImages[0] || product.imageUrl || null,
    images: normalizedImages,
    stock: Number(product.stock) || 0,
    stock_reserved: Number(product.stock_reserved) || 0,
    stock_available: stockAvailable,
    isAvailable: true,
    isBackorder: stockAvailable <= 0,
    backorderQuantity: stockAvailable < 0 ? Math.abs(stockAvailable) : 0,
    backorderNotice: stockAvailable <= 0 ? BACKORDER_NOTICE : null,
  };
};

const getProductVisibleUserIdsFromBody = (body) =>
  normalizeStringList(
    body?.visibleUserIds ??
      body?.allowedUserIds ??
      body?.clientIds ??
      body?.clients ??
      body?.users,
  );

const saveProductVisibility = async (
  productId,
  hidden,
  visibleUserIds,
  query = db,
) => {
  await query("product_visible_users").where({ productId }).del();

  if (!hidden) return;
  if (!Array.isArray(visibleUserIds) || visibleUserIds.length === 0) {
    throw validationError("Selecione ao menos um cliente para o produto oculto.");
  }

  const existingUsers = await query("users")
    .whereIn("id", visibleUserIds)
    .select("id");
  const existingIds = new Set(existingUsers.map((user) => String(user.id)));
  const missingIds = visibleUserIds.filter((userId) => !existingIds.has(userId));
  if (missingIds.length > 0) {
    throw validationError(`Cliente(s) nao encontrado(s): ${missingIds.join(", ")}`);
  }

  await query("product_visible_users").insert(
    visibleUserIds.map((userId) => ({
      productId,
      userId,
      created_at: new Date(),
    })),
  );
};

const OUTSOURCED_SERVICE_TYPES = {
  fabric_cutting: {
    label: "Retirada de tecido para corte",
    inputUnit: "metros",
    outputUnit: "unidades",
    inputMode: "measure",
    outputMode: "products",
  },
  embroidery: {
    label: "Bordagem",
    inputUnit: "unidades",
    outputUnit: "unidades",
    inputMode: "products",
    outputMode: "products",
  },
  sewing: {
    label: "Costura",
    inputUnit: "unidades",
    outputUnit: "unidades",
    inputMode: "products",
    outputMode: "products",
  },
  stuffing: {
    label: "Enchimento",
    inputUnit: "unidades",
    outputUnit: "unidades",
    inputMode: "products",
    outputMode: "products",
  },
  closing: {
    label: "Fechamento",
    inputUnit: "unidades",
    outputUnit: "unidades",
    inputMode: "products",
    outputMode: "products",
  },
};

const OUTSOURCED_SERVICE_TYPE_ALIASES = {
  embroidery_sewing: "embroidery",
  stuffing_closing: "stuffing",
};

const OUTSOURCED_SERVICE_RETENTION_DAYS = 60;

const makeServiceTypeIdFromLabel = (label) =>
  `service_${String(label || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}_${Date.now()}`;

const normalizeOutsourcedServiceType = (type) =>
  type
    ? {
        value: type.id || type.value,
        id: type.id || type.value,
        label: type.label,
        inputUnit: type.input_unit || type.inputUnit,
        outputUnit: type.output_unit || type.outputUnit,
        inputMode: type.input_mode || type.inputMode,
        outputMode: type.output_mode || type.outputMode,
        active: type.active === undefined ? true : isTruthyDb(type.active),
        builtIn: isTruthyDb(type.built_in ?? type.builtIn),
        created_at: type.created_at || null,
        updated_at: type.updated_at || null,
      }
    : null;

const getOutsourcedServiceTypes = async (
  { includeInactive = false } = {},
  query = db,
) => {
  if (!(await query.schema.hasTable("outsourced_service_types"))) {
    return Object.entries(OUTSOURCED_SERVICE_TYPES).map(([id, config]) =>
      normalizeOutsourcedServiceType({
        id,
        ...config,
        input_unit: config.inputUnit,
        output_unit: config.outputUnit,
        input_mode: config.inputMode,
        output_mode: config.outputMode,
        active: true,
        built_in: true,
      }),
    );
  }

  const typeQuery = query("outsourced_service_types").select("*");
  if (!includeInactive) typeQuery.where({ active: true });
  const rows = await typeQuery.orderBy("label", "asc");
  return rows.map(normalizeOutsourcedServiceType);
};

const getOutsourcedServiceTypeMap = async (
  { includeInactive = true } = {},
  query = db,
) => {
  const types = await getOutsourcedServiceTypes({ includeInactive }, query);
  return new Map(types.map((type) => [type.value, type]));
};

const toNumberOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toPositiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const toStockNumber = (value) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toJsonText = (value) =>
  value === undefined || value === null ? null : JSON.stringify(value);

const validationError = (message) =>
  Object.assign(new Error(message), { statusCode: 400 });

const toIsoDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const getOutsourcedServiceTypeKey = (serviceType) =>
  OUTSOURCED_SERVICE_TYPE_ALIASES[serviceType] || serviceType;

const getOutsourcedServiceTypeConfig = async (serviceType, query = db) => {
  const key = getOutsourcedServiceTypeKey(serviceType);
  const typeMap = await getOutsourcedServiceTypeMap(
    { includeInactive: true },
    query,
  );
  return typeMap.get(key) || OUTSOURCED_SERVICE_TYPES[key] || null;
};

const parseOutsourcedItems = (value) => {
  const parsed = parseJSON(value);
  return Array.isArray(parsed) ? parsed : [];
};

const normalizeOutsourcedProductItems = async (
  items,
  { required = false, requireStockControlled = true } = {},
) => {
  if (items === undefined || items === null || items === "") {
    if (required) throw validationError("Informe ao menos um produto.");
    return [];
  }

  const parsed = typeof items === "string" ? parseJSON(items) : items;
  if (!Array.isArray(parsed)) {
    throw validationError("Lista de produtos invalida.");
  }

  const normalized = [];
  for (const item of parsed) {
    const productId = getItemProductId(item);
    const quantity = toPositiveNumber(
      item?.quantity ?? item?.expected_quantity ?? item?.returned_quantity,
    );

    if (!productId || !quantity) {
      throw validationError(
        "Cada produto deve ter productId/id e quantidade maior que zero.",
      );
    }

    const product = await db("products").where({ id: productId }).first();
    if (!product) {
      throw validationError(`Produto ${productId} nao encontrado.`);
    }
    normalized.push({
      productId,
      id: productId,
      name: item?.name || product.name || productId,
      quantity,
    });
  }

  if (required && normalized.length === 0) {
    throw validationError("Informe ao menos um produto.");
  }

  return normalized;
};

const sumOutsourcedItemsQuantity = (items) =>
  (Array.isArray(items) ? items : []).reduce(
    (sum, item) => sum + (Number(item.quantity) || 0),
    0,
  );

const normalizeOutsourcedCompany = (company) =>
  company
    ? {
        ...company,
        active: !!company.active,
      }
    : null;

const normalizeEmployeeAccess = (employee) =>
  employee
    ? {
        id: employee.id,
        name: employee.name,
        username: employee.username,
        active: !!employee.active,
        created_at: employee.created_at,
        updated_at: employee.updated_at,
      }
    : null;

const getOutsourcedServiceStatus = (service) => {
  if (service.status === "concluido") return "concluido";
  const delivered = Number(service.total_delivered_quantity) || 0;
  const expected = Number(service.expected_return_quantity) || 0;
  return delivered >= expected ? "concluido" : "pendente";
};

const normalizeOutsourcedService = (service, typeMap = null) => {
  if (!service) return null;

  const serviceTypeKey = getOutsourcedServiceTypeKey(service.service_type);
  const typeConfig =
    typeMap?.get(serviceTypeKey) ||
    normalizeOutsourcedServiceType({
      id: serviceTypeKey,
      ...(OUTSOURCED_SERVICE_TYPES[serviceTypeKey] || {}),
      input_unit: OUTSOURCED_SERVICE_TYPES[serviceTypeKey]?.inputUnit,
      output_unit: OUTSOURCED_SERVICE_TYPES[serviceTypeKey]?.outputUnit,
      input_mode: OUTSOURCED_SERVICE_TYPES[serviceTypeKey]?.inputMode,
      output_mode: OUTSOURCED_SERVICE_TYPES[serviceTypeKey]?.outputMode,
      active: true,
    }) ||
    {};
  const totalDelivered = Number(service.total_delivered_quantity) || 0;
  const expectedReturn = Number(service.expected_return_quantity) || 0;
  const status = getOutsourcedServiceStatus(service);
  const now = Date.now();
  const dueDate = service.due_date ? new Date(service.due_date) : null;
  const isOverdue =
    status !== "concluido" &&
    dueDate &&
    !Number.isNaN(dueDate.getTime()) &&
    dueDate.getTime() < now;

  return {
    ...service,
    service_type_key: serviceTypeKey,
    service_type_label: typeConfig.label || service.service_type,
    input_unit: service.input_unit || typeConfig.inputUnit || null,
    input_mode: typeConfig.inputMode || null,
    expected_return_unit:
      service.expected_return_unit || typeConfig.outputUnit || null,
    output_mode: typeConfig.outputMode || null,
    input_items: parseOutsourcedItems(service.input_items),
    expected_return_items: parseOutsourcedItems(service.expected_return_items),
    input_quantity: Number(service.input_quantity) || 0,
    fabric_paid_amount:
      service.fabric_paid_amount === null ||
      service.fabric_paid_amount === undefined
        ? null
        : Number(service.fabric_paid_amount),
    service_cost_amount:
      service.service_cost_amount === null ||
      service.service_cost_amount === undefined
        ? null
        : Number(service.service_cost_amount),
    expected_return_quantity: expectedReturn,
    total_delivered_quantity: totalDelivered,
    remaining_quantity: Math.max(0, expectedReturn - totalDelivered),
    status,
    is_overdue: !!isOverdue,
  };
};

const normalizeOutsourcedServiceForRequest = (service, req, typeMap = null) => {
  const normalized = normalizeOutsourcedService(service, typeMap);
  if (!normalized || req.user?.role !== "employee") return normalized;

  const {
    fabric_paid_amount,
    service_cost_amount,
    ...employeeVisibleService
  } = normalized;
  return employeeVisibleService;
};

const cleanupExpiredOutsourcedServices = async () => {
  const cutoff = new Date(
    Date.now() - OUTSOURCED_SERVICE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

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

const dbType = process.env.DATABASE_URL
  ? "PostgreSQL (Render)"
  : "SQLite (Local)";
console.log(`🗄️ Usando banco: ${dbType}`);

// --- Configuração Redis para Cache ---
let redisClient = null;
let useRedis = false;

// Cache de pagamentos confirmados - Fallback Map para quando Redis não disponível
const confirmedPayments = new Map();

// Função para inicializar Redis (chamada junto com initDatabase)
async function initRedis() {
  if (REDIS_URL) {
    try {
      console.log("⏳ Conectando ao Redis...");
      redisClient = createClient({ url: REDIS_URL });

      redisClient.on("error", (err) => {
        console.error("❌ Erro Redis:", err.message);
        useRedis = false;
        console.log("⚠️ Usando Map em memória como fallback");
      });

      redisClient.on("connect", () => {
        console.log("✅ Redis conectado com sucesso!");
        useRedis = true;
      });

      // Conecta ao Redis
      await redisClient.connect();
    } catch (error) {
      console.error("❌ Falha ao conectar Redis:", error.message);
      console.log("⚠️ Usando Map em memória como fallback");
      redisClient = null;
      useRedis = false;
    }
  } else {
    console.log("ℹ️ REDIS_URL não configurado - usando Map em memória");
  }
}

// Funções auxiliares para cache unificado (Redis ou Map)
const cachePayment = async (key, value) => {
  if (useRedis && redisClient) {
    try {
      await redisClient.setEx(key, 3600, JSON.stringify(value)); // Expira em 1 hora
      return true;
    } catch (error) {
      console.error("❌ Erro ao salvar no Redis, usando Map:", error.message);
      confirmedPayments.set(key, value);
      return true;
    }
  } else {
    confirmedPayments.set(key, value);
    return true;
  }
};

const getCachedPayment = async (key) => {
  if (useRedis && redisClient) {
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error("❌ Erro ao ler do Redis, usando Map:", error.message);
      return confirmedPayments.get(key) || null;
    }
  } else {
    return confirmedPayments.get(key) || null;
  }
};

const deleteCachedPayment = async (key) => {
  if (useRedis && redisClient) {
    try {
      await redisClient.del(key);
    } catch (error) {
      console.error("❌ Erro ao deletar do Redis:", error.message);
    }
  }
  confirmedPayments.delete(key);
};

// ⚠️ CRON JOBS MOVIDOS PARA WORKER SEPARADO
// Ver: workers/cronJobs.js (node-cron) ou workers/bullQueue.js (Bull + Redis)
//
// Benefícios:
// - ✅ Não bloqueia o servidor HTTP
// - ✅ Pode ser escalado independentemente
// - ✅ Reinicia automaticamente em caso de erro
// - ✅ Logs isolados e estruturados
//
// Para iniciar o worker:
// - Desenvolvimento: npm run worker
// - Produção: pm2 start workers/cronJobs.js --name worker-cron

// Função para limpar cache antigo (a cada 1 hora) - apenas para Map (Redis tem TTL automático)
// Este permanece no servidor principal pois precisa acessar o Map em memória
setInterval(() => {
  if (!useRedis) {
    const oneHourAgo = Date.now() - 3600000;
    for (const [key, value] of confirmedPayments.entries()) {
      if (value.timestamp < oneHourAgo) {
        confirmedPayments.delete(key);
      }
    }
  }
}, 3600000);

// --- Inicialização do Banco (SEED) ---
async function initDatabase() {
  // Adiciona colunas extras para pagamento se não existirem
  const paymentCols = [
    { name: "paymentType", type: "string" },
    { name: "paymentMethod", type: "string" },
    { name: "installments", type: "integer" },
    { name: "fee", type: "decimal" },
  ];
  const hasOrdersForPaymentCols = await db.schema.hasTable("orders");
  if (hasOrdersForPaymentCols) {
    for (const col of paymentCols) {
    const hasCol = await db.schema.hasColumn("orders", col.name);
    if (!hasCol) {
      await db.schema.table("orders", (table) => {
        if (col.type === "string") table.string(col.name);
        if (col.type === "integer") table.integer(col.name);
        if (col.type === "decimal") table.decimal(col.name, 8, 2);
      });
      console.log(`✅ Coluna '${col.name}' adicionada à tabela orders`);
    }
  }
  console.log("⏳ Verificando tabelas...");

  }

  // ========== TABELA DE RECEBIMENTOS DO SUPER ADMIN ==========
  const hasReceivables = await db.schema.hasTable("super_admin_receivables");
  if (!hasReceivables) {
    await db.schema.createTable("super_admin_receivables", (table) => {
      table.increments("id").primary();
      table.decimal("amount", 10, 2).notNullable();
      table.text("order_ids");
      table.text("valorRecebidoDetalhado");
      table.timestamp("received_at").defaultTo(db.fn.now());
    });
    console.log("✅ Tabela 'super_admin_receivables' criada com sucesso");
  } else {
    // Adiciona a coluna order_ids se não existir
    const hasOrderIds = await db.schema.hasColumn(
      "super_admin_receivables",
      "order_ids",
    );
    if (!hasOrderIds) {
      await db.schema.alterTable("super_admin_receivables", (table) => {
        table.text("order_ids");
      });
      console.log(
        "✅ Coluna 'order_ids' adicionada à tabela 'super_admin_receivables'",
      );
    }
  }

  const hasProducts = await db.schema.hasTable("products");
  if (!hasProducts) {
    await db.schema.createTable("products", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.decimal("price", 8, 2).notNullable();
      table.decimal("priceRaw", 8, 2).notNullable().defaultTo(0); // Preço bruto
      table.string("category").notNullable();
      table.string("videoUrl");
      table.string("imageUrl"); // URL da imagem do produto
      table.text("images"); // Lista de URLs das imagens (JSON)
      table.boolean("popular").defaultTo(false);
      table.integer("stock").defaultTo(0); // 0 = sem estoque; compras podem deixar negativo
      table.integer("stock_reserved").defaultTo(0); // Estoque reservado temporariamente
      table.boolean("active").notNullable().defaultTo(true);
      table.boolean("hidden").notNullable().defaultTo(false);
      table.integer("quantidadeVenda").defaultTo(1);
      table.integer("minStock").defaultTo(0); // Estoque mínimo
    });
    // Adiciona coluna imageUrl se não existir
    const hasImageUrl = await db.schema.hasColumn("products", "imageUrl");
    if (!hasImageUrl) {
      await db.schema.table("products", (table) => {
        table.string("imageUrl");
      });
      console.log("✅ Coluna imageUrl adicionada");
    }
  } else {
    // Remover coluna description se existir
    const hasDescription = await db.schema.hasColumn("products", "description");
    if (hasDescription) {
      try {
        await db.schema.table("products", (table) => {
          table.dropColumn("description");
        });
        console.log("✅ Coluna description removida");
      } catch (e) {
        console.warn(
          "⚠️ Não foi possível remover coluna description (pode ser limitação do SQLite)",
        );
      }
    }
    // Adiciona coluna priceRaw se não existir
    const hasPriceRaw = await db.schema.hasColumn("products", "priceRaw");
    if (!hasPriceRaw) {
      await db.schema.table("products", (table) => {
        table.decimal("priceRaw", 8, 2).notNullable().defaultTo(0);
      });
      console.log("✅ Coluna priceRaw adicionada");
    }
    // Adiciona coluna minStock se não existir
    const hasMinStock = await db.schema.hasColumn("products", "minStock");
    if (!hasMinStock) {
      await db.schema.table("products", (table) => {
        table.integer("minStock").defaultTo(0);
      });
      console.log("✅ Coluna minStock adicionada");
    }
    // ...existing code para stock_reserved e stock...
    const hasReservedColumn = await db.schema.hasColumn(
      "products",
      "stock_reserved",
    );
    if (!hasReservedColumn) {
      await db.schema.table("products", (table) => {
        table.integer("stock_reserved").defaultTo(0);
      });
      console.log("✅ Coluna stock_reserved adicionada");
    }
    const hasStock = await db.schema.hasColumn("products", "stock");
    if (!hasStock) {
      await db.schema.table("products", (table) => {
        table.integer("stock").defaultTo(0);
      });
      console.log("✅ Coluna stock adicionada à tabela products");
    }
    await db("products").whereNull("stock").update({ stock: 0 });
    const hasImages = await db.schema.hasColumn("products", "images");
    if (!hasImages) {
      await db.schema.table("products", (table) => {
        table.text("images");
      });
      console.log("✅ Coluna images adicionada à tabela products");
    }
    const hasProductActive = await db.schema.hasColumn("products", "active");
    if (!hasProductActive) {
      await db.schema.table("products", (table) => {
        table.boolean("active").notNullable().defaultTo(true);
      });
      console.log("Coluna active adicionada a tabela products");
    }
    const hasProductHidden = await db.schema.hasColumn("products", "hidden");
    if (!hasProductHidden) {
      await db.schema.table("products", (table) => {
        table.boolean("hidden").notNullable().defaultTo(false);
      });
      console.log("Coluna hidden adicionada a tabela products");
    }
    const hasQuantidadeVenda = await db.schema.hasColumn(
      "products",
      "quantidadeVenda",
    );
    if (!hasQuantidadeVenda) {
      await db.schema.table("products", (table) => {
        table.integer("quantidadeVenda").defaultTo(1);
      });
      console.log("Coluna quantidadeVenda adicionada a tabela products");
    }
    const hasValorRecebidoDetalhado = await db.schema.hasColumn(
      "super_admin_receivables",
      "valorRecebidoDetalhado",
    );
    if (!hasValorRecebidoDetalhado) {
      await db.schema.alterTable("super_admin_receivables", (table) => {
        table.text("valorRecebidoDetalhado");
      });
      console.log(
        "Coluna 'valorRecebidoDetalhado' adicionada a super_admin_receivables",
      );
    }
  }

  const hasUsers = await db.schema.hasTable("users");
  if (!hasUsers) {
    await db.schema.createTable("users", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.string("email").unique();
      table.string("cpf").unique();
      table.string("password");
      table.string("role").defaultTo("customer");
      table.string("cep");
      table.text("address");
      table.string("phone");
      table.json("historico").defaultTo("[]");
      table.integer("pontos").defaultTo(0);
      table.boolean("fullAccess").notNullable().defaultTo(false);
      table.boolean("monthlyPayment").notNullable().defaultTo(false);
    });
  }

  const userOptionalColumns = [
    { name: "password", type: "string" },
    { name: "role", type: "string" },
    { name: "cep", type: "string" },
    { name: "address", type: "text" },
    { name: "phone", type: "string" },
    { name: "fullAccess", type: "boolean" },
    { name: "monthlyPayment", type: "boolean" },
  ];
  for (const col of userOptionalColumns) {
    const hasCol = await db.schema.hasColumn("users", col.name);
    if (!hasCol) {
      await db.schema.table("users", (table) => {
        if (col.type === "string") table.string(col.name);
        if (col.type === "text") table.text(col.name);
        if (col.type === "boolean") {
          table.boolean(col.name).notNullable().defaultTo(false);
        }
      });
      console.log(`Coluna '${col.name}' adicionada a tabela users`);
    }
  }

  await db("products").whereNull("hidden").update({ hidden: false });

  if (!(await db.schema.hasTable("product_visible_users"))) {
    await db.schema.createTable("product_visible_users", (table) => {
      table.increments("id").primary();
      table
        .string("productId")
        .notNullable()
        .references("id")
        .inTable("products")
        .onDelete("CASCADE");
      table
        .string("userId")
        .notNullable()
        .references("id")
        .inTable("users")
        .onDelete("CASCADE");
      table.timestamp("created_at").defaultTo(db.fn.now());
      table.unique(["productId", "userId"]);
    });
    console.log("Tabela 'product_visible_users' criada com sucesso");
  }

  const hasUserProductPrices = await db.schema.hasTable("user_product_prices");
  if (!hasUserProductPrices) {
    await db.schema.createTable("user_product_prices", (table) => {
      table.increments("id").primary();
      table
        .string("userId")
        .notNullable()
        .references("id")
        .inTable("users")
        .onDelete("CASCADE");
      table
        .string("productId")
        .notNullable()
        .references("id")
        .inTable("products")
        .onDelete("CASCADE");
      table.decimal("price", 12, 2).notNullable();
      table.timestamp("created_at").defaultTo(db.fn.now());
      table.timestamp("updated_at").defaultTo(db.fn.now());
      table.unique(["userId", "productId"]);
    });
    console.log("Tabela 'user_product_prices' criada com sucesso");
  }

  const hasShippingCarriers = await db.schema.hasTable("shipping_carriers");
  if (!hasShippingCarriers) {
    await db.schema.createTable("shipping_carriers", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.text("trackingUrl");
      table.boolean("active").notNullable().defaultTo(true);
      table.timestamp("created_at").defaultTo(db.fn.now());
      table.timestamp("updated_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'shipping_carriers' criada com sucesso");
  }

  const defaultCarriers = [
    {
      id: "carrier_uniao_express",
      name: "União Express",
      trackingUrl: "https://www.uniaoexpress.com.br/rastreamento",
      active: true,
    },
    {
      id: "carrier_outra_transportadora",
      name: "Outra transportadora",
      trackingUrl: null,
      active: true,
    },
  ];
  for (const carrier of defaultCarriers) {
    const exists = await db("shipping_carriers").where({ id: carrier.id }).first();
    if (!exists) {
      await db("shipping_carriers").insert({
        ...carrier,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }

  const hasOrders = await db.schema.hasTable("orders");
  if (!hasOrders) {
    await db.schema.createTable("orders", (table) => {
      table.string("id").primary();
      table
        .string("userId")
        .references("id")
        .inTable("users")
        .onDelete("SET NULL");
      table.string("userName");
      table.decimal("total", 8, 2).notNullable();
      table.string("timestamp").notNullable();
      table.string("status").defaultTo("active");
      table.string("paymentStatus").defaultTo("pending");
      table.string("paymentId");
      table.string("paymentType");
      table.string("paymentMethod");
      table.integer("installments");
      table.decimal("fee", 8, 2);
      table.json("items").notNullable();
      table.timestamp("completedAt");
      table.boolean("hasBackorder").defaultTo(false);
      table.text("backorderNotice");
      table.boolean("stockDeducted").defaultTo(false);
      table.boolean("monthlyBilling").defaultTo(false);
      table.string("monthlyBillingMonth");
      table.timestamp("monthlyClosedAt");
      table.string("monthlyClosedBy");
      table.string("deliveryMethod").defaultTo("contact");
      table.string("carrierId");
      table.boolean("hiddenFromHistory").defaultTo(false);
      table.timestamp("hiddenAt");
      table.string("hiddenBy");
      table.boolean("entregueCliente").defaultTo(false);
      table.text("separationChecklist");
      table.timestamp("separationChecklistUpdatedAt");
      table.timestamp("created_at").defaultTo(db.fn.now());
    });
  }

  // Adiciona a coluna 'observation' se ela não existir
  const hasObservationColumn = await db.schema.hasColumn(
    "orders",
    "observation",
  );
  if (!hasObservationColumn) {
    await db.schema.table("orders", (table) => {
      table.text("observation"); // Usando text para permitir observações mais longas
    });
    console.log("✅ Coluna 'observation' adicionada à tabela orders");
  }

  const hasHiddenFromHistoryColumn = await db.schema.hasColumn(
    "orders",
    "hiddenFromHistory",
  );
  if (!hasHiddenFromHistoryColumn) {
    await db.schema.table("orders", (table) => {
      table.boolean("hiddenFromHistory").defaultTo(false);
    });
    console.log("✅ Coluna 'hiddenFromHistory' adicionada à tabela orders");
  }

  const hasHiddenAtColumn = await db.schema.hasColumn("orders", "hiddenAt");
  if (!hasHiddenAtColumn) {
    await db.schema.table("orders", (table) => {
      table.timestamp("hiddenAt");
    });
    console.log("✅ Coluna 'hiddenAt' adicionada à tabela orders");
  }

  const hasHiddenByColumn = await db.schema.hasColumn("orders", "hiddenBy");
  if (!hasHiddenByColumn) {
    await db.schema.table("orders", (table) => {
      table.string("hiddenBy");
    });
    console.log("✅ Coluna 'hiddenBy' adicionada à tabela orders");
  }

  const hasEntregueClienteColumn = await db.schema.hasColumn(
    "orders",
    "entregueCliente",
  );
  if (!hasEntregueClienteColumn) {
    await db.schema.table("orders", (table) => {
      table.boolean("entregueCliente").defaultTo(false);
    });
    console.log("✅ Coluna 'entregueCliente' adicionada à tabela orders");
  }

  const separationChecklistColumns = [
    { name: "separationChecklist", type: "text" },
    { name: "separationChecklistUpdatedAt", type: "timestamp" },
  ];
  for (const col of separationChecklistColumns) {
    const hasCol = await db.schema.hasColumn("orders", col.name);
    if (!hasCol) {
      await db.schema.table("orders", (table) => {
        if (col.type === "text") table.text(col.name);
        if (col.type === "timestamp") table.timestamp(col.name);
      });
      console.log(`Coluna '${col.name}' adicionada a orders`);
    }
  }

  const hasOrderCreatedAtColumn = await db.schema.hasColumn(
    "orders",
    "created_at",
  );
  if (!hasOrderCreatedAtColumn) {
    await db.schema.table("orders", (table) => {
      table.timestamp("created_at").defaultTo(db.fn.now());
    });
    console.log("Coluna 'created_at' adicionada a orders");
  }

  const backorderOrderColumns = [
    { name: "hasBackorder", type: "boolean" },
    { name: "backorderNotice", type: "text" },
    { name: "stockDeducted", type: "boolean" },
    { name: "monthlyBilling", type: "boolean" },
    { name: "monthlyBillingMonth", type: "string" },
    { name: "monthlyClosedAt", type: "timestamp" },
    { name: "monthlyClosedBy", type: "string" },
    { name: "deliveryMethod", type: "string" },
    { name: "carrierId", type: "string" },
  ];
  for (const col of backorderOrderColumns) {
    const hasCol = await db.schema.hasColumn("orders", col.name);
    if (!hasCol) {
      await db.schema.table("orders", (table) => {
        if (col.type === "boolean") table.boolean(col.name).defaultTo(false);
        if (col.type === "text") table.text(col.name);
        if (col.type === "string") table.string(col.name);
        if (col.type === "timestamp") table.timestamp(col.name);
      });
      console.log(`Coluna '${col.name}' adicionada a orders`);
    }
  }
  await db("orders").whereNull("deliveryMethod").update({
    deliveryMethod: "contact",
  });

  const superAdminOrderColumns = [
    { name: "repassadoSuperAdmin", type: "boolean" },
    { name: "dataRepasseSuperAdmin", type: "timestamp" },
    { name: "valorRecebido", type: "decimal" },
  ];
  for (const col of superAdminOrderColumns) {
    const hasCol = await db.schema.hasColumn("orders", col.name);
    if (!hasCol) {
      await db.schema.table("orders", (table) => {
        if (col.type === "boolean") table.boolean(col.name).defaultTo(false);
        if (col.type === "timestamp") table.timestamp(col.name);
        if (col.type === "decimal") table.decimal(col.name, 12, 2);
      });
      console.log(`Coluna '${col.name}' adicionada a orders`);
    }
  }

  if (!(await db.schema.hasTable("order_products"))) {
    await db.schema.createTable("order_products", (table) => {
      table.increments("id").primary();
      table
        .string("order_id")
        .notNullable()
        .references("id")
        .inTable("orders")
        .onDelete("CASCADE");
      table
        .string("product_id")
        .references("id")
        .inTable("products")
        .onDelete("SET NULL");
      table.integer("quantity").notNullable().defaultTo(1);
      table.decimal("price", 12, 2).notNullable().defaultTo(0);
      table.timestamp("created_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'order_products' criada com sucesso");
  } else {
    const orderProductsColumns = [
      { name: "order_id", type: "string" },
      { name: "product_id", type: "string" },
      { name: "quantity", type: "integer" },
      { name: "price", type: "decimal" },
      { name: "created_at", type: "timestamp" },
    ];

    for (const col of orderProductsColumns) {
      const hasCol = await db.schema.hasColumn("order_products", col.name);
      if (!hasCol) {
        await db.schema.table("order_products", (table) => {
          if (col.type === "string") table.string(col.name);
          if (col.type === "integer") table.integer(col.name).defaultTo(1);
          if (col.type === "decimal")
            table.decimal(col.name, 12, 2).defaultTo(0);
          if (col.type === "timestamp")
            table.timestamp(col.name).defaultTo(db.fn.now());
        });
        console.log(`Coluna '${col.name}' adicionada a order_products`);
      }
    }
  }

  // ========== TABELA DE CATEGORIAS (Multi-tenancy) ==========
  if (!(await db.schema.hasTable("categories"))) {
    await db.schema.createTable("categories", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.string("icon").defaultTo("📦"); // Emoji da categoria
      table.integer("order").defaultTo(0); // Ordem de exibição
      table.timestamp("created_at").defaultTo(db.fn.now());
    });
    console.log("✅ Tabela 'categories' criada com sucesso");
  }

  // Modo single-tenant: não cria tabela de lojas
  if (!(await db.schema.hasTable("stock_movements"))) {
    await db.schema.createTable("stock_movements", (table) => {
      table.string("id").primary();
      table
        .string("product_id")
        .references("id")
        .inTable("products")
        .onDelete("SET NULL");
      table.string("product_name");
      table.string("type").notNullable();
      table.integer("quantity").notNullable();
      table.text("reason");
      table.string("created_by");
      table.timestamp("created_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'stock_movements' criada com sucesso");
  }

  if (!(await db.schema.hasTable("management_expenses"))) {
    await db.schema.createTable("management_expenses", (table) => {
      table.string("id").primary();
      table.string("description").notNullable();
      table.decimal("amount", 12, 2).notNullable();
      table.string("category");
      table.timestamp("expense_date").notNullable();
      table.text("notes");
      table.timestamp("created_at").defaultTo(db.fn.now());
      table.timestamp("updated_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'management_expenses' criada com sucesso");
  }

  if (!(await db.schema.hasTable("employee_accesses"))) {
    await db.schema.createTable("employee_accesses", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.string("username").notNullable().unique();
      table.string("password").notNullable();
      table.boolean("active").notNullable().defaultTo(true);
      table.string("created_by");
      table.timestamp("created_at").defaultTo(db.fn.now());
      table.timestamp("updated_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'employee_accesses' criada com sucesso");
  }

  if (!(await db.schema.hasTable("outsourced_companies"))) {
    await db.schema.createTable("outsourced_companies", (table) => {
      table.string("id").primary();
      table.string("name").notNullable();
      table.string("document");
      table.string("contact_name");
      table.string("phone");
      table.string("email");
      table.text("address");
      table.text("notes");
      table.boolean("active").notNullable().defaultTo(true);
      table.timestamp("created_at").defaultTo(db.fn.now());
      table.timestamp("updated_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'outsourced_companies' criada com sucesso");
  }

  if (!(await db.schema.hasTable("outsourced_service_types"))) {
    await db.schema.createTable("outsourced_service_types", (table) => {
      table.string("id").primary();
      table.string("label").notNullable();
      table.string("input_unit").notNullable();
      table.string("output_unit").notNullable();
      table.string("input_mode").notNullable().defaultTo("products");
      table.string("output_mode").notNullable().defaultTo("products");
      table.boolean("active").notNullable().defaultTo(true);
      table.boolean("built_in").notNullable().defaultTo(false);
      table.timestamp("created_at").defaultTo(db.fn.now());
      table.timestamp("updated_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'outsourced_service_types' criada com sucesso");
  }

  const outsourcedServiceTypeColumns = [
    { name: "input_unit", type: "string" },
    { name: "output_unit", type: "string" },
    { name: "input_mode", type: "string" },
    { name: "output_mode", type: "string" },
    { name: "active", type: "boolean" },
    { name: "built_in", type: "boolean" },
    { name: "created_at", type: "timestamp" },
    { name: "updated_at", type: "timestamp" },
  ];
  for (const col of outsourcedServiceTypeColumns) {
    const hasCol = await db.schema.hasColumn("outsourced_service_types", col.name);
    if (!hasCol) {
      await db.schema.table("outsourced_service_types", (table) => {
        if (col.type === "string") table.string(col.name);
        if (col.type === "boolean") table.boolean(col.name).defaultTo(false);
        if (col.type === "timestamp") table.timestamp(col.name);
      });
      console.log(`Coluna ${col.name} adicionada a outsourced_service_types`);
    }
  }

  for (const [id, config] of Object.entries(OUTSOURCED_SERVICE_TYPES)) {
    const exists = await db("outsourced_service_types").where({ id }).first();
    if (!exists) {
      await db("outsourced_service_types").insert({
        id,
        label: config.label,
        input_unit: config.inputUnit,
        output_unit: config.outputUnit,
        input_mode: config.inputMode,
        output_mode: config.outputMode,
        active: true,
        built_in: true,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }

  if (!(await db.schema.hasTable("outsourced_services"))) {
    await db.schema.createTable("outsourced_services", (table) => {
      table.string("id").primary();
      table
        .string("company_id")
        .notNullable()
        .references("id")
        .inTable("outsourced_companies")
        .onDelete("RESTRICT");
      table.string("service_type").notNullable();
      table.string("status").notNullable().defaultTo("pendente");
      table.decimal("input_quantity", 12, 3).notNullable();
      table.string("input_unit").notNullable();
      table.text("input_items");
      table.decimal("fabric_paid_amount", 12, 2);
      table.decimal("service_cost_amount", 12, 2);
      table.decimal("expected_return_quantity", 12, 3).notNullable();
      table.string("expected_return_unit").notNullable();
      table.text("expected_return_items");
      table.decimal("total_delivered_quantity", 12, 3).notNullable().defaultTo(0);
      table.timestamp("due_date").notNullable();
      table.timestamp("started_at").defaultTo(db.fn.now());
      table.timestamp("completed_at");
      table.text("notes");
      table.timestamp("created_at").defaultTo(db.fn.now());
      table.timestamp("updated_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'outsourced_services' criada com sucesso");
  } else {
    const hasServiceCostAmount = await db.schema.hasColumn(
      "outsourced_services",
      "service_cost_amount",
    );
    if (!hasServiceCostAmount) {
      await db.schema.table("outsourced_services", (table) => {
        table.decimal("service_cost_amount", 12, 2);
      });
      console.log("Coluna service_cost_amount adicionada a outsourced_services");
    }
    const outsourcedServiceJsonColumns = [
      "input_items",
      "expected_return_items",
    ];
    for (const colName of outsourcedServiceJsonColumns) {
      const hasCol = await db.schema.hasColumn("outsourced_services", colName);
      if (!hasCol) {
        await db.schema.table("outsourced_services", (table) => {
          table.text(colName);
        });
        console.log(`Coluna ${colName} adicionada a outsourced_services`);
      }
    }
  }

  if (!(await db.schema.hasTable("outsourced_service_deliveries"))) {
    await db.schema.createTable("outsourced_service_deliveries", (table) => {
      table.string("id").primary();
      table
        .string("service_id")
        .notNullable()
        .references("id")
        .inTable("outsourced_services")
        .onDelete("CASCADE");
      table.string("product_id");
      table.string("product_name");
      table.text("items");
      table.decimal("quantity", 12, 3).notNullable();
      table.timestamp("delivered_at").notNullable();
      table.text("observation");
      table.timestamp("created_at").defaultTo(db.fn.now());
    });
    console.log("Tabela 'outsourced_service_deliveries' criada com sucesso");
  } else {
    const outsourcedDeliveryColumns = [
      { name: "product_id", type: "string" },
      { name: "product_name", type: "string" },
      { name: "items", type: "text" },
    ];
    for (const col of outsourcedDeliveryColumns) {
      const hasCol = await db.schema.hasColumn(
        "outsourced_service_deliveries",
        col.name,
      );
      if (!hasCol) {
        await db.schema.table("outsourced_service_deliveries", (table) => {
          if (col.type === "string") table.string(col.name);
          if (col.type === "text") table.text(col.name);
        });
        console.log(
          `Coluna ${col.name} adicionada a outsourced_service_deliveries`,
        );
      }
    }
  }

  try {
    const removedServices = await cleanupExpiredOutsourcedServices();
    if (removedServices > 0) {
      console.log(
        `${removedServices} servico(s) terceirizado(s) com mais de 60 dias removido(s)`,
      );
    }
  } catch (e) {
    console.warn(
      "Nao foi possivel limpar servicos terceirizados antigos:",
      e.message,
    );
  }

  // Configure as credenciais Mercado Pago no .env
  // ...existing code...

  // Endpoint para gerar e baixar o PDF do pedido
  app.get("/api/orders/:id/receipt-pdf", async (req, res) => {
    try {
      const orderId = req.params.id;
      // Buscar o pedido no banco de dados
      const order = await db("orders").where({ id: orderId }).first();
      if (!order) {
        return res.status(404).json({ error: "Pedido não encontrado" });
      }
      // Buscar itens do pedido a partir da tabela order_products
      const orderProducts = await db("order_products").where({
        order_id: order.id,
      });
      // Buscar dados dos produtos para cada item
      const items = [];
      for (const op of orderProducts) {
        const product = await db("products")
          .where({ id: op.product_id })
          .first();
        items.push({
          id: op.product_id,
          name: product ? product.name : "-",
          price: op.price,
          quantity: op.quantity,
        });
      }
      order.items = items;

      // Buscar dados do usuário
      let user = null;
      if (order.userId) {
        user = await db("users").where({ id: order.userId }).first();
      }
      if (user) {
        order.userName = user.name || order.userName;
        order.email = user.email || order.email;
        order.cpf = user.cpf || order.cpf;
        // Adicione outros campos conforme necessário (telefone, endereço, etc.)
        // Exemplo:
        order.phone = user.phone || order.phone;
        order.address = user.address || order.address;
        order.cep = user.cep || order.cep;
      }

      const { generateStyledOrderPdf } =
        await import("./services/styledOrderPdf.js");
      const pdfBuffer = await generateStyledOrderPdf(order);

      // PDF estilizado
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename=pedido-${order.id}.pdf`,
      );
      res.send(pdfBuffer);
    } catch (error) {
      console.error("Erro ao gerar PDF do pedido:", error);
      if (!res.headersSent) {
        return res.status(500).json({ error: "Erro ao gerar PDF do pedido" });
      }
      res.end();
    }
  });
  // ...existing code...
  // ========== LOGIN POR CPF E SENHA ===========
  app.post("/api/users/login", async (req, res) => {
    const { cpf, password } = req.body; // Mantemos 'cpf' no destructuring para não quebrar o contrato

    if (!cpf || !password) {
      return res.status(400).json({ error: "Documento e senha obrigatórios" });
    }

    const docClean = String(cpf).replace(/\D/g, "");

    // Validação de tamanho para evitar consultas desnecessárias
    if (docClean.length !== 11 && docClean.length !== 14) {
      return res
        .status(400)
        .json({ error: "Documento inválido. Deve ser CPF ou CNPJ." });
    }

    try {
      const user = await db("users").where({ cpf: docClean }).first();

      if (!user) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }

      // Nota: Em produção, use bcrypt para comparar senhas!
      if (user.password !== password) {
        return res.status(401).json({ error: "Senha incorreta" });
      }

      const normalizedRole = user.role || "customer";
      const token = JWT_SECRET
        ? jwt.sign(
            { role: normalizedRole, userId: user.id },
            JWT_SECRET,
            { expiresIn: "8h" },
          )
        : null;

      res.json({
        success: true,
        token,
        user: normalizeUserResponse({
          ...user,
          role: normalizedRole,
        }),
      });
    } catch (e) {
      console.error("❌ Erro ao autenticar usuário:", e);
      res.status(500).json({ error: "Erro ao autenticar usuário" });
    }
  });

  const result = await db("products").count("id as count").first();
  if (Number(result.count) === 0) {
    try {
      const menuDataPath = path.join(process.cwd(), "data", "menu.json");
      const rawData = await fs.readFile(menuDataPath, "utf-8");
      await db("products").insert(JSON.parse(rawData));
      console.log("✅ Menu carregado com sucesso!");
    } catch (e) {
      console.error("⚠️ Erro ao carregar menu.json:", e.message);
    }
  } else {
    console.log(`✅ O banco já contém ${result.count} produtos.`);
  }

  // Verifica OpenAI
  if (openai) {
    console.log("🤖 OpenAI configurada - IA disponível");
  } else {
    console.log("⚠️ OpenAI NÃO configurada - OPENAI_API_KEY não encontrada");
  }
}

// ...a definição da rota PUT /api/users/:id deve ser movida para depois dos middlewares, logo após app.use(express.json()) e app.use(cors(...))

// --- Middlewares ---

// Permissões CORS para web e apps móveis (Capacitor)

const secondaryAllowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://point-point-frontend.vercel.app",
  "https://point-point-frontend-lo377nqek-gabriel-akiras-projects.vercel.app",
  "https://primeplush.com.br",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      // Permite requisições sem origin (apps móveis nativos)
      if (!origin) return callback(null, true);
      if (
        secondaryAllowedOrigins.includes(origin) ||
        isAllowedVercelPreviewOrigin(origin)
      ) {
        return callback(null, true);
      } else {
        console.warn(`CORS bloqueado para origem: ${origin}`);
        return callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Super-Admin-Password"],
    credentials: true,
  }),
);
app.use(express.json());

// Endpoint para listar todos os produtos (admin)

// --- Rotas de Pagamento Multi-tenant ---
// TEMPORARIAMENTE DESABILITADO - Usando rotas antigas funcionais (linhas 1807+)
// app.use("/api/payment", paymentRoutes);

// --- Rotas Básicas ---
app.get("/", (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; text-align: center; padding: 20px;">
      <h1>Point&amp;Point Backend Online</h1>
      <p>Banco: <strong>${dbType}</strong></p>
      <p>Status: <strong>OPERACIONAL (Modo Busca por Valor)</strong></p>
    </div>
  `);
});

app.get("/health", (req, res) =>
  res.status(200).json({ status: "ok", db: dbType }),
);

// Endpoint de debug removido: store_id não é mais utilizado

// Rota de teste do webhook (para verificar se está acessível)
app.get("/api/webhooks/mercadopago", (req, res) => {
  console.log("📋 GET recebido no webhook - Teste manual ou verificação do MP");
  res.status(200).json({
    message: "Webhook endpoint ativo! Use POST para enviar notificações.",
    ready: true,
    method: "GET - Para receber notificações reais, o MP deve usar POST",
  });
});

// --- Rota de Autenticação Segura ---
app.post("/api/auth/login", async (req, res) => {
  const { role, password, username } = req.body;

  if (!role || !password) {
    return res
      .status(400)
      .json({ success: false, message: "Role e senha são obrigatórios" });
  }

  if (role === "employee") {
    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Usuario e senha sao obrigatorios para funcionario",
      });
    }

    if (!JWT_SECRET) {
      console.error("JWT_SECRET nao configurado para login de funcionario");
      return res
        .status(500)
        .json({ success: false, message: "Erro de configuracao no servidor." });
    }

    try {
      const employee = await db("employee_accesses")
        .where({ username: String(username).trim(), active: true })
        .first();

      if (!employee || employee.password !== password) {
        return res
          .status(401)
          .json({ success: false, message: "Usuario ou senha invalidos" });
      }

      const token = jwt.sign(
        {
          role: "employee",
          employeeId: employee.id,
          name: employee.name,
        },
        JWT_SECRET,
        { expiresIn: "8h" },
      );

      return res.json({
        success: true,
        token,
        user: normalizeEmployeeAccess(employee),
      });
    } catch (error) {
      console.error("Erro no login de funcionario:", error);
      return res.status(500).json({
        success: false,
        message: "Erro ao autenticar funcionario",
      });
    }
  }

  let correctPassword;
  if (role === "admin") {
    correctPassword = ADMIN_PASSWORD;
  } else if (role === "kitchen") {
    correctPassword = KITCHEN_PASSWORD;
  } else if (role === "superadmin") {
    correctPassword = SUPER_ADMIN_PASSWORD;
  } else {
    return res.status(400).json({ success: false, message: "Role inválido" });
  }

  if (!correctPassword) {
    console.error(
      `⚠️ A senha para a role '${role}' não está configurada nas variáveis de ambiente.`,
    );
    return res
      .status(500)
      .json({ success: false, message: "Erro de configuração no servidor." });
  }

  if (password === correctPassword) {
    if (!JWT_SECRET) {
      console.error(
        "🚨 JWT_SECRET não está configurado! Não é possível gerar token.",
      );
      return res
        .status(500)
        .json({ success: false, message: "Erro de configuração no servidor." });
    }
    // Gera o token JWT com a role do usuário, válido por 8 horas
    const token = jwt.sign({ role }, JWT_SECRET, { expiresIn: "8h" });
    console.log(`✅ Login bem-sucedido para a role: ${role}`);
    res.json({ success: true, token });
  } else {
    console.log(`❌ Tentativa de login falhou para a role: ${role}`);
    res.status(401).json({ success: false, message: "Senha inválida" });
  }
});

// MODO SINGLE-TENANT

// --- Rotas da API (Menu, Usuários, Pedidos) ---

app.get("/api/menu", async (req, res) => {
  try {
    const catalogContext = await resolveCatalogContext(req);
    // SINGLE-TENANT: Retorna todos os produtos
    const products = await db("products")
      .select("*")
      .where({ active: true })
      .orderBy("id");
    const visibilityMap = await getProductVisibilityMap(
      products.map((product) => product.id),
    );
    const visibleProducts = await applyUserProductPrices(
      filterCatalogProducts(products, {
        ...catalogContext,
        visibilityMap,
      }),
      catalogContext.userId,
    );
    console.log(
      `✅ [GET /api/menu] Retornando ${products.length} produtos (single-tenant)`,
    );

    res.json(visibleProducts.map(normalizeProductResponse));
  } catch (e) {
    console.error(`❌ [GET /api/menu] ERRO ao buscar menu:`, e.message);
    console.error(`❌ [GET /api/menu] Stack:`, e.stack);
    res.status(500).json({
      error: "Erro ao buscar menu",
      details: e.message,
    });
  }
});

// --- Middlewares de Autenticação e Autorização ---

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Formato: "Bearer TOKEN"

  if (token == null) {
    return res
      .status(401)
      .json({ error: "Acesso negado. Token não fornecido." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log(`❌ Token inválido: ${err.message}`);
      return res.status(403).json({ error: "Token inválido ou expirado." });
    }
    req.user = user; // Adiciona o payload do token (ex: { role: 'admin' }) à requisição
    next();
  });
};

const authorizeAdmin = (req, res, next) => {
  if (req.user.role !== "admin" && req.user.role !== "superadmin") {
    return res
      .status(403)
      .json({ error: "Acesso negado. Requer permissão de administrador." });
  }
  next();
};

const authorizeOutsourcedAccess = (req, res, next) => {
  if (
    req.user.role !== "employee" &&
    req.user.role !== "admin" &&
    req.user.role !== "superadmin"
  ) {
    return res.status(403).json({
      error:
        "Acesso negado. Requer permissao de funcionario, administrador ou superadmin.",
    });
  }
  next();
};

const authorizeSuperAdminAccess = (req, res, next) => {
  const password = req.headers["x-super-admin-password"];
  if (password && password === SUPER_ADMIN_PASSWORD) {
    return next();
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .json({ error: "Acesso negado. Credencial de superadmin ausente." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err || user.role !== "superadmin") {
      return res
        .status(403)
        .json({ error: "Acesso negado. Requer superadmin." });
    }

    req.user = user;
    next();
  });
};

const authorizeKitchen = (req, res, next) => {
  if (req.user.role !== "kitchen" && req.user.role !== "admin") {
    return res.status(403).json({
      error: "Acesso negado. Requer permissão da cozinha ou de administrador.",
    });
  }
  next();
};

app.get(
  "/api/super-admin/employees",
  authorizeSuperAdminAccess,
  async (req, res) => {
    try {
      const employees = await db("employee_accesses")
        .select("id", "name", "username", "active", "created_at", "updated_at")
        .orderBy("created_at", "desc");

      res.json(employees.map(normalizeEmployeeAccess));
    } catch (e) {
      console.error("Erro ao buscar acessos de funcionarios:", e);
      res.status(500).json({ error: "Erro ao buscar funcionarios" });
    }
  },
);

app.post(
  "/api/super-admin/employees",
  authorizeSuperAdminAccess,
  async (req, res) => {
    try {
      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      const username =
        typeof req.body.username === "string" ? req.body.username.trim() : "";
      const password =
        typeof req.body.password === "string" ? req.body.password : "";

      if (!name || !username || !password) {
        return res.status(400).json({
          error: "Nome, usuario e senha do funcionario sao obrigatorios",
        });
      }

      const existing = await db("employee_accesses").where({ username }).first();
      if (existing) {
        return res.status(409).json({ error: "Usuario ja cadastrado" });
      }

      const now = new Date().toISOString();
      const employee = {
        id: req.body.id || `emp_${Date.now()}`,
        name,
        username,
        password,
        active: req.body.active === undefined ? true : !!req.body.active,
        created_by: req.user?.role || "superadmin",
        created_at: now,
        updated_at: now,
      };

      await db("employee_accesses").insert(employee);
      res.status(201).json(normalizeEmployeeAccess(employee));
    } catch (e) {
      console.error("Erro ao criar acesso de funcionario:", e);
      res.status(500).json({ error: "Erro ao criar funcionario" });
    }
  },
);

app.put(
  "/api/super-admin/employees/:id",
  authorizeSuperAdminAccess,
  async (req, res) => {
    try {
      const employee = await db("employee_accesses")
        .where({ id: req.params.id })
        .first();

      if (!employee) {
        return res.status(404).json({ error: "Funcionario nao encontrado" });
      }

      const updates = { updated_at: new Date().toISOString() };
      if (req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return res.status(400).json({ error: "Nome obrigatorio" });
        updates.name = name;
      }
      if (req.body.username !== undefined) {
        const username = String(req.body.username).trim();
        if (!username) {
          return res.status(400).json({ error: "Usuario obrigatorio" });
        }
        const duplicate = await db("employee_accesses")
          .where({ username })
          .whereNot({ id: req.params.id })
          .first();
        if (duplicate) {
          return res.status(409).json({ error: "Usuario ja cadastrado" });
        }
        updates.username = username;
      }
      if (req.body.password !== undefined) {
        if (!String(req.body.password)) {
          return res.status(400).json({ error: "Senha obrigatoria" });
        }
        updates.password = String(req.body.password);
      }
      if (req.body.active !== undefined) updates.active = !!req.body.active;

      await db("employee_accesses").where({ id: req.params.id }).update(updates);
      const updated = await db("employee_accesses")
        .where({ id: req.params.id })
        .first();

      res.json(normalizeEmployeeAccess(updated));
    } catch (e) {
      console.error("Erro ao atualizar acesso de funcionario:", e);
      res.status(500).json({ error: "Erro ao atualizar funcionario" });
    }
  },
);

app.delete(
  "/api/super-admin/employees/:id",
  authorizeSuperAdminAccess,
  async (req, res) => {
    try {
      const deleted = await db("employee_accesses")
        .where({ id: req.params.id })
        .del();

      if (!deleted) {
        return res.status(404).json({ error: "Funcionario nao encontrado" });
      }

      res.json({ success: true });
    } catch (e) {
      console.error("Erro ao excluir acesso de funcionario:", e);
      res.status(500).json({ error: "Erro ao excluir funcionario" });
    }
  },
);

app.get(
  "/api/admin/stock-movements",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const movements = await db("stock_movements")
        .select("*")
        .orderBy("created_at", "desc")
        .limit(200);

      res.json(
        movements.map((movement) => ({
          ...movement,
          quantity: Number(movement.quantity) || 0,
        })),
      );
    } catch (e) {
      console.error("Erro ao buscar movimentacoes de estoque:", e);
      res.status(500).json({ error: "Erro ao buscar movimentacoes de estoque" });
    }
  },
);

app.get(
  "/api/admin/backordered-products",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const negativeStockProducts = await db("products")
        .select("*")
        .whereNotNull("stock")
        .andWhere("stock", "<", 0)
        .orderBy("stock", "asc");

      const orders = await db("orders")
        .select("*")
        .where({ hasBackorder: true })
        .andWhere(function () {
          this.whereNotIn("paymentStatus", [
            "canceled",
            "cancelled",
            "rejected",
            "refunded",
          ]).orWhereNull("paymentStatus");
        })
        .andWhere(function () {
          this.whereNot("status", "canceled").orWhereNull("status");
        })
        .orderBy("timestamp", "desc")
        .limit(100);

      const pendingBackordersByProduct = new Map();
      for (const order of orders) {
        const orderItems = parseJSON(order.items);
        for (const item of orderItems) {
          if (!item?.isBackorder) continue;

          const productId = getItemProductId(item);
          if (!productId) continue;

          const current = pendingBackordersByProduct.get(String(productId)) || 0;
          pendingBackordersByProduct.set(
            String(productId),
            current + (Number(item.backorderQuantity) || 0),
          );
        }
      }

      const productsById = new Map(
        negativeStockProducts.map((product) => [String(product.id), product]),
      );
      const missingProductIds = [...pendingBackordersByProduct.keys()].filter(
        (productId) => !productsById.has(productId),
      );
      if (missingProductIds.length > 0) {
        const pendingProducts = await db("products")
          .select("*")
          .whereIn("id", missingProductIds);
        pendingProducts.forEach((product) => {
          productsById.set(String(product.id), product);
        });
      }

      const products = [...productsById.values()].sort(
        (a, b) => (Number(a.stock) || 0) - (Number(b.stock) || 0),
      );

      res.json({
        success: true,
        notice: BACKORDER_NOTICE,
        totalProducts: products.length,
        totalBackorderedUnits: products.reduce(
          (sum, product) =>
            sum +
            Math.max(
              Math.abs(Math.min(0, Number(product.stock) || 0)),
              pendingBackordersByProduct.get(String(product.id)) || 0,
            ),
          0,
        ),
        products: products.map((product) => ({
          id: product.id,
          name: product.name,
          category: product.category,
          stock: Number(product.stock) || 0,
          backorderQuantity: Math.max(
            Math.abs(Math.min(0, Number(product.stock) || 0)),
            pendingBackordersByProduct.get(String(product.id)) || 0,
          ),
          pendingBackorderQuantity:
            pendingBackordersByProduct.get(String(product.id)) || 0,
          minStock: Number(product.minStock) || 0,
          imageUrl: product.imageUrl || null,
          notice: BACKORDER_NOTICE,
        })),
        orders: orders.map((order) => ({
          ...order,
          items: parseJSON(order.items),
          total: parseFloat(order.total),
          hasBackorder: !!order.hasBackorder,
          backorderNotice: order.backorderNotice || BACKORDER_NOTICE,
        })),
      });
    } catch (e) {
      console.error("Erro ao buscar produtos sob encomenda:", e);
      res.status(500).json({ error: "Erro ao buscar produtos sob encomenda" });
    }
  },
);

app.get(
  "/api/admin/management-expenses",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const query = db("management_expenses").select("*");
      const startAt = toIsoDate(req.query.startAt);
      const endAt = toIsoDate(req.query.endAt);

      if (startAt) query.where("expense_date", ">=", startAt);
      if (endAt) query.where("expense_date", "<=", endAt);

      const expenses = await query.orderBy("expense_date", "desc");
      res.json(
        expenses.map((expense) => ({
          ...expense,
          amount: Number(expense.amount) || 0,
        })),
      );
    } catch (e) {
      console.error("Erro ao buscar gastos:", e);
      res.status(500).json({ error: "Erro ao buscar gastos" });
    }
  },
);

app.post(
  "/api/admin/management-expenses",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const description =
        typeof req.body.description === "string"
          ? req.body.description.trim()
          : "";
      const amount = toPositiveNumber(req.body.amount);
      const expenseDate = toIsoDate(req.body.expense_date || req.body.date);

      if (!description) {
        return res.status(400).json({ error: "Descricao do gasto obrigatoria" });
      }
      if (!amount) {
        return res
          .status(400)
          .json({ error: "Valor do gasto deve ser maior que zero" });
      }
      if (!expenseDate) {
        return res.status(400).json({ error: "Data do gasto invalida" });
      }

      const now = new Date().toISOString();
      const expense = {
        id: req.body.id || `exp_${Date.now()}`,
        description,
        amount,
        category: req.body.category || null,
        expense_date: expenseDate,
        notes: req.body.notes || null,
        created_at: now,
        updated_at: now,
      };

      await db("management_expenses").insert(expense);
      res.status(201).json({ ...expense, amount: Number(expense.amount) });
    } catch (e) {
      console.error("Erro ao cadastrar gasto:", e);
      res.status(500).json({ error: "Erro ao cadastrar gasto" });
    }
  },
);

app.put(
  "/api/admin/management-expenses/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const exists = await db("management_expenses")
        .where({ id: req.params.id })
        .first();

      if (!exists) {
        return res.status(404).json({ error: "Gasto nao encontrado" });
      }

      const updates = { updated_at: new Date().toISOString() };
      if (req.body.description !== undefined) {
        const description = String(req.body.description).trim();
        if (!description) {
          return res
            .status(400)
            .json({ error: "Descricao do gasto obrigatoria" });
        }
        updates.description = description;
      }
      if (req.body.amount !== undefined) {
        const amount = toPositiveNumber(req.body.amount);
        if (!amount) {
          return res
            .status(400)
            .json({ error: "Valor do gasto deve ser maior que zero" });
        }
        updates.amount = amount;
      }
      if (req.body.expense_date !== undefined || req.body.date !== undefined) {
        const expenseDate = toIsoDate(req.body.expense_date || req.body.date);
        if (!expenseDate) {
          return res.status(400).json({ error: "Data do gasto invalida" });
        }
        updates.expense_date = expenseDate;
      }
      if (req.body.category !== undefined) updates.category = req.body.category;
      if (req.body.notes !== undefined) updates.notes = req.body.notes;

      await db("management_expenses").where({ id: req.params.id }).update(updates);
      const updated = await db("management_expenses")
        .where({ id: req.params.id })
        .first();

      res.json({ ...updated, amount: Number(updated.amount) || 0 });
    } catch (e) {
      console.error("Erro ao atualizar gasto:", e);
      res.status(500).json({ error: "Erro ao atualizar gasto" });
    }
  },
);

app.delete(
  "/api/admin/management-expenses/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const deleted = await db("management_expenses")
        .where({ id: req.params.id })
        .del();

      if (!deleted) {
        return res.status(404).json({ error: "Gasto nao encontrado" });
      }

      res.json({ success: true });
    } catch (e) {
      console.error("Erro ao excluir gasto:", e);
      res.status(500).json({ error: "Erro ao excluir gasto" });
    }
  },
);

app.get(
  "/api/admin/outsourced-services/types",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    const includeInactive =
      req.query.includeInactive === "true" &&
      (req.user.role === "admin" || req.user.role === "superadmin");
    const types = await getOutsourcedServiceTypes({ includeInactive });
    res.json({
      types,
      legacyAliases: OUTSOURCED_SERVICE_TYPE_ALIASES,
    });
  },
);

app.post(
  "/api/admin/outsourced-services/types",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const label = String(req.body.label || "").trim();
      const inputUnit = String(req.body.inputUnit || req.body.input_unit || "").trim();
      const outputUnit = String(req.body.outputUnit || req.body.output_unit || "").trim();
      const inputMode = String(req.body.inputMode || req.body.input_mode || "products").trim();
      const outputMode = String(req.body.outputMode || req.body.output_mode || "products").trim();

      if (!label || !inputUnit || !outputUnit) {
        return res.status(400).json({
          error: "label, inputUnit e outputUnit sao obrigatorios",
        });
      }
      if (!["products", "measure"].includes(inputMode)) {
        return res.status(400).json({ error: "inputMode invalido" });
      }
      if (!["products", "measure"].includes(outputMode)) {
        return res.status(400).json({ error: "outputMode invalido" });
      }

      const id = req.body.id || req.body.value || makeServiceTypeIdFromLabel(label);
      const exists = await db("outsourced_service_types").where({ id }).first();
      if (exists) {
        return res.status(409).json({ error: "Tipo de servico ja existe" });
      }

      const now = new Date();
      const type = {
        id,
        label,
        input_unit: inputUnit,
        output_unit: outputUnit,
        input_mode: inputMode,
        output_mode: outputMode,
        active: req.body.active === undefined ? true : isTruthyDb(req.body.active),
        built_in: false,
        created_at: now,
        updated_at: now,
      };

      await db("outsourced_service_types").insert(type);
      res.status(201).json(normalizeOutsourcedServiceType(type));
    } catch (e) {
      console.error("Erro ao cadastrar tipo de servico:", e);
      res.status(500).json({ error: "Erro ao cadastrar tipo de servico" });
    }
  },
);

app.put(
  "/api/admin/outsourced-services/types/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const type = await db("outsourced_service_types")
        .where({ id: req.params.id })
        .first();
      if (!type) {
        return res.status(404).json({ error: "Tipo de servico nao encontrado" });
      }

      const updates = { updated_at: new Date() };
      if (req.body.label !== undefined) {
        const label = String(req.body.label || "").trim();
        if (!label) return res.status(400).json({ error: "label e obrigatorio" });
        updates.label = label;
      }
      if (req.body.inputUnit !== undefined || req.body.input_unit !== undefined) {
        const inputUnit = String(req.body.inputUnit ?? req.body.input_unit ?? "").trim();
        if (!inputUnit) return res.status(400).json({ error: "inputUnit e obrigatorio" });
        updates.input_unit = inputUnit;
      }
      if (req.body.outputUnit !== undefined || req.body.output_unit !== undefined) {
        const outputUnit = String(req.body.outputUnit ?? req.body.output_unit ?? "").trim();
        if (!outputUnit) return res.status(400).json({ error: "outputUnit e obrigatorio" });
        updates.output_unit = outputUnit;
      }
      if (req.body.inputMode !== undefined || req.body.input_mode !== undefined) {
        const inputMode = String(req.body.inputMode ?? req.body.input_mode ?? "").trim();
        if (!["products", "measure"].includes(inputMode)) {
          return res.status(400).json({ error: "inputMode invalido" });
        }
        updates.input_mode = inputMode;
      }
      if (req.body.outputMode !== undefined || req.body.output_mode !== undefined) {
        const outputMode = String(req.body.outputMode ?? req.body.output_mode ?? "").trim();
        if (!["products", "measure"].includes(outputMode)) {
          return res.status(400).json({ error: "outputMode invalido" });
        }
        updates.output_mode = outputMode;
      }
      if (req.body.active !== undefined) updates.active = isTruthyDb(req.body.active);

      await db("outsourced_service_types").where({ id: req.params.id }).update(updates);
      const updated = await db("outsourced_service_types")
        .where({ id: req.params.id })
        .first();
      res.json(normalizeOutsourcedServiceType(updated));
    } catch (e) {
      console.error("Erro ao atualizar tipo de servico:", e);
      res.status(500).json({ error: "Erro ao atualizar tipo de servico" });
    }
  },
);

app.delete(
  "/api/admin/outsourced-services/types/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const type = await db("outsourced_service_types")
        .where({ id: req.params.id })
        .first();
      if (!type) {
        return res.status(404).json({ error: "Tipo de servico nao encontrado" });
      }

      const usage = await db("outsourced_services")
        .where({ service_type: req.params.id })
        .count("id as count")
        .first();
      if (Number(usage.count) > 0) {
        return res.status(409).json({
          error: "Nao e possivel excluir um tipo usado em servicos existentes",
          servicesCount: Number(usage.count),
        });
      }

      await db("outsourced_service_types").where({ id: req.params.id }).del();
      res.json({ success: true });
    } catch (e) {
      console.error("Erro ao excluir tipo de servico:", e);
      res.status(500).json({ error: "Erro ao excluir tipo de servico" });
    }
  },
);

app.get(
  "/api/admin/outsourced-services/products",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const products = await db("products")
        .select("id", "name", "category", "stock", "imageUrl")
        .whereNotNull("stock")
        .orderBy("name", "asc");

      res.json(products.map(normalizeProductResponse));
    } catch (e) {
      console.error("Erro ao buscar produtos para terceirizados:", e);
      res.status(500).json({ error: "Erro ao buscar produtos" });
    }
  },
);

app.get(
  "/api/admin/outsourced-companies",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const includeInactive = req.query.includeInactive === "true";
      const query = db("outsourced_companies").select("*");

      if (!includeInactive) query.where({ active: true });

      const companies = await query.orderBy("name", "asc");
      res.json(companies.map(normalizeOutsourcedCompany));
    } catch (e) {
      console.error("Erro ao buscar empresas terceirizadas:", e);
      res.status(500).json({ error: "Erro ao buscar empresas terceirizadas" });
    }
  },
);

app.post(
  "/api/admin/outsourced-companies",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        return res.status(400).json({ error: "Nome da empresa e obrigatorio" });
      }

      const now = new Date().toISOString();
      const company = {
        id: req.body.id || `third_${Date.now()}`,
        name,
        document: req.body.document || null,
        contact_name: req.body.contact_name || null,
        phone: req.body.phone || null,
        email: req.body.email || null,
        address: req.body.address || null,
        notes: req.body.notes || null,
        active: req.body.active === undefined ? true : !!req.body.active,
        created_at: now,
        updated_at: now,
      };

      await db("outsourced_companies").insert(company);
      res.status(201).json(normalizeOutsourcedCompany(company));
    } catch (e) {
      console.error("Erro ao cadastrar empresa terceirizada:", e);
      res.status(500).json({ error: "Erro ao cadastrar empresa terceirizada" });
    }
  },
);

app.put(
  "/api/admin/outsourced-companies/:id",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const { id } = req.params;
      const exists = await db("outsourced_companies").where({ id }).first();
      if (!exists) {
        return res
          .status(404)
          .json({ error: "Empresa terceirizada nao encontrada" });
      }

      const updates = { updated_at: new Date().toISOString() };
      [
        "name",
        "document",
        "contact_name",
        "phone",
        "email",
        "address",
        "notes",
      ].forEach((field) => {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      });

      if (req.body.active !== undefined) updates.active = !!req.body.active;
      if (updates.name !== undefined && !String(updates.name).trim()) {
        return res.status(400).json({ error: "Nome da empresa e obrigatorio" });
      }

      await db("outsourced_companies").where({ id }).update(updates);
      const updated = await db("outsourced_companies").where({ id }).first();
      res.json(normalizeOutsourcedCompany(updated));
    } catch (e) {
      console.error("Erro ao atualizar empresa terceirizada:", e);
      res.status(500).json({ error: "Erro ao atualizar empresa terceirizada" });
    }
  },
);

app.get(
  "/api/admin/outsourced-services",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const { status, companyId, overdue } = req.query;
      const query = db("outsourced_services as s")
        .leftJoin("outsourced_companies as c", "s.company_id", "c.id")
        .select("s.*", "c.name as company_name")
        .orderBy("s.created_at", "desc");

      if (companyId) query.where("s.company_id", companyId);
      if (status && status !== "todos") query.where("s.status", status);
      if (overdue === "true") {
        query
          .where("s.status", "pendente")
          .where("s.due_date", "<", new Date().toISOString());
      }

      const services = await query;
      const typeMap = await getOutsourcedServiceTypeMap();
      res.json(
        services.map((service) =>
          normalizeOutsourcedServiceForRequest(service, req, typeMap),
        ),
      );
    } catch (e) {
      console.error("Erro ao buscar servicos terceirizados:", e);
      res.status(500).json({ error: "Erro ao buscar servicos terceirizados" });
    }
  },
);

app.get(
  "/api/admin/outsourced-services/alerts",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const services = await db("outsourced_services as s")
        .leftJoin("outsourced_companies as c", "s.company_id", "c.id")
        .select("s.*", "c.name as company_name")
        .where("s.status", "pendente")
        .where("s.due_date", "<", new Date().toISOString())
        .orderBy("s.due_date", "asc");

      const typeMap = await getOutsourcedServiceTypeMap();
      res.json({
        count: services.length,
        alerts: services.map((service) =>
          normalizeOutsourcedServiceForRequest(service, req, typeMap),
        ),
      });
    } catch (e) {
      console.error("Erro ao buscar alertas de servicos terceirizados:", e);
      res.status(500).json({ error: "Erro ao buscar alertas" });
    }
  },
);

app.get(
  "/api/admin/outsourced-services/:id",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const service = await db("outsourced_services as s")
        .leftJoin("outsourced_companies as c", "s.company_id", "c.id")
        .select("s.*", "c.name as company_name")
        .where("s.id", req.params.id)
        .first();

      if (!service) {
        return res.status(404).json({ error: "Servico nao encontrado" });
      }

      const deliveries = await db("outsourced_service_deliveries")
        .where({ service_id: req.params.id })
        .orderBy("delivered_at", "desc");

      const typeMap = await getOutsourcedServiceTypeMap();
      res.json({
        ...normalizeOutsourcedServiceForRequest(service, req, typeMap),
        deliveries: deliveries.map((delivery) => ({
          ...delivery,
          items: parseOutsourcedItems(delivery.items),
          quantity: Number(delivery.quantity) || 0,
        })),
      });
    } catch (e) {
      console.error("Erro ao buscar servico terceirizado:", e);
      res.status(500).json({ error: "Erro ao buscar servico terceirizado" });
    }
  },
);

app.post(
  "/api/admin/outsourced-services",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const companyId = req.body.company_id || req.body.companyId;
      const company = await db("outsourced_companies")
        .where({ id: companyId, active: true })
        .first();

      if (!company) {
        return res
          .status(400)
          .json({ error: "Empresa terceirizada ativa e obrigatoria" });
      }

      const serviceType = getOutsourcedServiceTypeKey(req.body.service_type);
      const typeConfig = await getOutsourcedServiceTypeConfig(serviceType);
      if (!typeConfig) {
        return res.status(400).json({ error: "Tipo de servico invalido" });
      }

      const inputItems = await normalizeOutsourcedProductItems(
        req.body.input_items || req.body.inputItems,
      );
      const inputQuantity =
        inputItems.length > 0
          ? sumOutsourcedItemsQuantity(inputItems)
          : toPositiveNumber(req.body.input_quantity);
      const expectedReturnItems = await normalizeOutsourcedProductItems(
        req.body.expected_return_items || req.body.expectedReturnItems,
      );
      const expectedReturnQuantity =
        expectedReturnItems.length > 0
          ? sumOutsourcedItemsQuantity(expectedReturnItems)
          : toPositiveNumber(req.body.expected_return_quantity);
      const dueDate = toIsoDate(req.body.due_date);
      const fabricPaidAmount = toNumberOrNull(req.body.fabric_paid_amount);
      const serviceCostAmount = toNumberOrNull(req.body.service_cost_amount);

      if (!inputQuantity) {
        return res
          .status(400)
          .json({ error: "Quantidade retirada deve ser maior que zero" });
      }
      if (!expectedReturnQuantity) {
        return res
          .status(400)
          .json({ error: "Quantidade prevista de retorno e obrigatoria" });
      }
      if (typeConfig.outputMode === "products" && expectedReturnItems.length === 0) {
        return res.status(400).json({
          error: "Informe os produtos e quantidades previstos para retorno.",
        });
      }
      if (!dueDate) {
        return res.status(400).json({ error: "Prazo de entrega invalido" });
      }
      if (fabricPaidAmount !== null && fabricPaidAmount < 0) {
        return res
          .status(400)
          .json({ error: "Valor pago pelo tecido nao pode ser negativo" });
      }
      if (serviceCostAmount !== null && serviceCostAmount < 0) {
        return res
          .status(400)
          .json({ error: "Valor cobrado pelo servico nao pode ser negativo" });
      }

      const now = new Date().toISOString();
      const service = {
        id: req.body.id || `outs_${Date.now()}`,
        company_id: companyId,
        service_type: serviceType,
        status: "pendente",
        input_quantity: inputQuantity,
        input_unit: typeConfig.inputUnit,
        input_items: toJsonText(inputItems),
        fabric_paid_amount: fabricPaidAmount,
        service_cost_amount: serviceCostAmount,
        expected_return_quantity: expectedReturnQuantity,
        expected_return_unit: typeConfig.outputUnit,
        expected_return_items: toJsonText(expectedReturnItems),
        total_delivered_quantity: 0,
        due_date: dueDate,
        started_at: toIsoDate(req.body.started_at) || now,
        completed_at: null,
        notes: req.body.notes || null,
        created_at: now,
        updated_at: now,
      };

      await db("outsourced_services").insert(service);
      const typeMap = await getOutsourcedServiceTypeMap();
      res.status(201).json(
        normalizeOutsourcedServiceForRequest(
          {
            ...service,
            company_name: company.name,
          },
          req,
          typeMap,
        ),
      );
    } catch (e) {
      console.error("Erro ao criar servico terceirizado:", e);
      res
        .status(e.statusCode || 500)
        .json({ error: e.statusCode ? e.message : "Erro ao criar servico terceirizado" });
    }
  },
);

app.post(
  "/api/admin/outsourced-services/:id/deliveries",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const service = await db("outsourced_services")
        .where({ id: req.params.id })
        .first();

      if (!service) {
        return res.status(404).json({ error: "Servico nao encontrado" });
      }
      if (service.status === "concluido") {
        return res.status(400).json({ error: "Servico ja esta concluido" });
      }

      let deliveryItems = await normalizeOutsourcedProductItems(
        req.body.items || req.body.return_items || req.body.returnItems,
      );
      if (deliveryItems.length === 0 && (req.body.product_id || req.body.productId)) {
        deliveryItems = await normalizeOutsourcedProductItems([
          {
            productId: req.body.product_id || req.body.productId,
            quantity: req.body.quantity,
          },
        ]);
      }
      const quantity =
        deliveryItems.length > 0
          ? sumOutsourcedItemsQuantity(deliveryItems)
          : toPositiveNumber(req.body.quantity);
      const deliveredAt = toIsoDate(req.body.delivered_at || req.body.date);

      if (!quantity) {
        return res
          .status(400)
          .json({ error: "Quantidade entregue deve ser maior que zero" });
      }
      if (deliveryItems.length === 0) {
        return res.status(400).json({
          error: "Informe o produto retornado e a quantidade entregue.",
        });
      }
      if (!deliveredAt) {
        return res.status(400).json({ error: "Data da entrega invalida" });
      }

      const currentDelivered = Number(service.total_delivered_quantity) || 0;
      const expectedReturn = Number(service.expected_return_quantity) || 0;
      const newDelivered = currentDelivered + quantity;
      const now = new Date().toISOString();
      const newStatus = newDelivered >= expectedReturn ? "concluido" : "pendente";

      const delivery = {
        id: req.body.id || `del_${Date.now()}`,
        service_id: req.params.id,
        product_id: deliveryItems.length === 1 ? deliveryItems[0].productId : null,
        product_name: deliveryItems.length === 1 ? deliveryItems[0].name : null,
        items: toJsonText(deliveryItems),
        quantity,
        delivered_at: deliveredAt,
        observation: req.body.observation || null,
        created_at: now,
      };

      await db.transaction(async (trx) => {
        await trx("outsourced_service_deliveries").insert(delivery);
        for (const item of deliveryItems) {
          const product = await trx("products")
            .where({ id: item.productId })
            .first();
          if (product) {
            await trx("products")
              .where({ id: item.productId })
              .update({
                stock: (Number(product.stock) || 0) + (Number(item.quantity) || 0),
              });
          }
        }
        await trx("outsourced_services")
          .where({ id: req.params.id })
          .update({
            total_delivered_quantity: newDelivered,
            status: newStatus,
            completed_at: newStatus === "concluido" ? now : null,
            updated_at: now,
          });
      });

      const updated = await db("outsourced_services as s")
        .leftJoin("outsourced_companies as c", "s.company_id", "c.id")
        .select("s.*", "c.name as company_name")
        .where("s.id", req.params.id)
        .first();

      const typeMap = await getOutsourcedServiceTypeMap();
      res.status(201).json({
        delivery: {
          ...delivery,
          items: deliveryItems,
          quantity: Number(delivery.quantity) || 0,
        },
        service: normalizeOutsourcedServiceForRequest(updated, req, typeMap),
      });
    } catch (e) {
      console.error("Erro ao lancar entrega terceirizada:", e);
      res
        .status(e.statusCode || 500)
        .json({ error: e.statusCode ? e.message : "Erro ao lancar entrega" });
    }
  },
);

app.put(
  "/api/admin/outsourced-services/:id/finalize",
  authenticateToken,
  authorizeOutsourcedAccess,
  async (req, res) => {
    try {
      const service = await db("outsourced_services")
        .where({ id: req.params.id })
        .first();

      if (!service) {
        return res.status(404).json({ error: "Servico nao encontrado" });
      }

      const now = new Date().toISOString();
      await db("outsourced_services").where({ id: req.params.id }).update({
        status: "concluido",
        completed_at: now,
        updated_at: now,
      });

      const updated = await db("outsourced_services as s")
        .leftJoin("outsourced_companies as c", "s.company_id", "c.id")
        .select("s.*", "c.name as company_name")
        .where("s.id", req.params.id)
        .first();

      const typeMap = await getOutsourcedServiceTypeMap();
      res.json(normalizeOutsourcedServiceForRequest(updated, req, typeMap));
    } catch (e) {
      console.error("Erro ao finalizar servico terceirizado:", e);
      res.status(500).json({ error: "Erro ao finalizar servico terceirizado" });
    }
  },
);

// Relatório de gestão para admin (usa a mesma base de cálculo do superadmin)
app.get(
  "/api/admin/management-report",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const startAtRaw =
        typeof req.query.startAt === "string" ? req.query.startAt.trim() : "";
      const endAtRaw =
        typeof req.query.endAt === "string" ? req.query.endAt.trim() : "";

      if ((startAtRaw && !endAtRaw) || (!startAtRaw && endAtRaw)) {
        return res.status(400).json({
          error: "Informe a data inicial e final para aplicar o filtro.",
        });
      }

      let startAt = "";
      let endAt = "";

      if (startAtRaw && endAtRaw) {
        const parsedStartAt = new Date(startAtRaw);
        const parsedEndAt = new Date(endAtRaw);

        if (
          Number.isNaN(parsedStartAt.getTime()) ||
          Number.isNaN(parsedEndAt.getTime())
        ) {
          return res.status(400).json({
            error: "Periodo informado invalido.",
          });
        }

        if (parsedStartAt > parsedEndAt) {
          return res.status(400).json({
            error: "A data inicial nao pode ser maior que a final.",
          });
        }

        startAt = parsedStartAt.toISOString();
        endAt = parsedEndAt.toISOString();
      }

      const applyOrderDateRange = (query) => {
        if (startAt) {
          query.where("timestamp", ">=", startAt);
        }
        if (endAt) {
          query.where("timestamp", "<=", endAt);
        }
        return query;
      };

      const applyDateRange = (query, columnName) => {
        if (startAt) {
          query.where(columnName, ">=", startAt);
        }
        if (endAt) {
          query.where(columnName, "<=", endAt);
        }
        return query;
      };

      const successfulPaymentStatuses = ["paid", "authorized", "approved"];
      const canceledPaymentStatuses = ["canceled", "cancelled", "rejected"];

      const isSuccessfulOrder = (order) =>
        successfulPaymentStatuses.includes(
          String(order.paymentStatus || "").toLowerCase(),
        );

      const isCanceledOrder = (order) => {
        const normalizedPaymentStatus = String(
          order.paymentStatus || "",
        ).toLowerCase();
        const normalizedOrderStatus = String(order.status || "").toLowerCase();

        return (
          canceledPaymentStatuses.includes(normalizedPaymentStatus) ||
          normalizedOrderStatus === "canceled"
        );
      };

      const normalizePaymentMethod = (method) => {
        const normalized = String(method || "")
          .toLowerCase()
          .trim();

        if (!normalized) {
          return { key: "outros", label: "Outros" };
        }

        if (normalized.includes("pix")) {
          return { key: "pix", label: "Pix" };
        }

        const debitMethods = new Set([
          "debit",
          "debito",
          "debit_card",
          "debvisa",
          "debmaster",
          "maestro",
        ]);

        if (debitMethods.has(normalized) || normalized.includes("debit")) {
          return { key: "debit", label: "Cartao de Debito" };
        }

        const creditMethods = new Set([
          "credit",
          "credito",
          "credit_card",
          "visa",
          "master",
          "mastercard",
          "elo",
          "amex",
          "american_express",
          "hipercard",
          "diners",
          "discover",
          "jcb",
          "cabal",
          "tarshop",
        ]);

        if (creditMethods.has(normalized) || normalized.includes("credit")) {
          return { key: "credit", label: "Cartao de Credito" };
        }

        return { key: "outros", label: "Outros" };
      };

      const padNumber = (value) => String(value).padStart(2, "0");
      const formatDateKey = (date) =>
        `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(
          date.getDate(),
        )}`;
      const dailyLabelFormatter = new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "2-digit",
      });
      const monthLabelFormatter = new Intl.DateTimeFormat("pt-BR", {
        month: "short",
        year: "2-digit",
      });
      const getWeekStart = (date) => {
        const weekStart = new Date(date);
        weekStart.setHours(0, 0, 0, 0);
        const dayOfWeek = (weekStart.getDay() + 6) % 7;
        weekStart.setDate(weekStart.getDate() - dayOfWeek);
        return weekStart;
      };
      const pushRevenuePoint = (map, key, payload) => {
        const current = map.get(key) || {
          label: payload.label,
          revenue: 0,
          orders: 0,
          sortKey: payload.sortKey,
        };

        current.revenue += payload.revenue;
        current.orders += 1;
        map.set(key, current);
      };

      const receivablesRows = [];
      const alreadyProcessedIds = [];

      receivablesRows.forEach((row) => {
        if (!row?.order_ids) return;
        try {
          const ids = JSON.parse(row.order_ids);
          if (Array.isArray(ids)) {
            ids.forEach((id) => {
              if (id) {
                const normalizedId = String(id);
                alreadyProcessedIds.push(normalizedId);
              }
            });
          }
        } catch (e) {
          // Ignore linhas inválidas de histórico
        }
      });

      const paidOrders = await applyOrderDateRange(
        db("orders")
          .whereIn("paymentStatus", successfulPaymentStatuses)
          .select(
            "id",
            "items",
            "total",
            "timestamp",
            "paymentMethod",
            "paymentStatus",
            "status",
          ),
      );

      // Mantém a mesma regra do histórico para evitar divergência de KPI:
      // (paid/authorized) OU pagamento presencial.
      const ordersInRange = await applyOrderDateRange(
        db("orders")
          .where(function () {
            this.whereIn("paymentStatus", ["paid", "authorized"]).orWhere(
              function () {
                this.where("paymentType", "presencial");
              },
            );
          })
          .select(
            "id",
            "items",
            "total",
            "timestamp",
            "paymentMethod",
            "paymentStatus",
            "status",
            "paymentType",
          ),
      );

      const productRows = await db("products").select(
        "id",
        "name",
        "priceRaw",
        "category",
        "stock",
        "minStock",
      );
      const productMetaMap = new Map();

      productRows.forEach((product) => {
        const productId = String(product.id);
        productMetaMap.set(productId, {
          name: product.name || "Produto",
          unitCost: Number(product.priceRaw) || 0,
          category: product.category || "Outros",
          stock: Number(product.stock) || 0,
          minStock: Number(product.minStock) || 0,
        });
      });

      const productSales = new Map();
      const categorySalesMap = new Map();
      const paymentDistributionMap = new Map();
      const dailyRevenueMap = new Map();
      const weeklyRevenueMap = new Map();
      const monthlyRevenueMap = new Map();
      let totalRevenue = 0;
      let totalItemsSold = 0;

      const calculatePeriodDays = () => {
        if (startAt && endAt) {
          const ms = new Date(endAt).getTime() - new Date(startAt).getTime();
          return Math.max(1, Math.floor(ms / (24 * 60 * 60 * 1000)) + 1);
        }

        if (paidOrders.length === 0) {
          return 1;
        }

        const validTimestamps = paidOrders
          .map((order) => new Date(order.timestamp).getTime())
          .filter((value) => Number.isFinite(value));

        if (validTimestamps.length === 0) {
          return 1;
        }

        const minTimestamp = Math.min(...validTimestamps);
        const maxTimestamp = Math.max(...validTimestamps);
        const rangeInDays =
          Math.floor((maxTimestamp - minTimestamp) / (24 * 60 * 60 * 1000)) + 1;

        return Math.max(1, rangeInDays);
      };

      const periodDays = calculatePeriodDays();

      const getUnitCostByItem = (item) => {
        const prodId = item.productId || item.id;
        if (!prodId) return 0;
        const meta = productMetaMap.get(String(prodId));
        return meta ? meta.unitCost : 0;
      };

      const successfulOrdersCount =
        ordersInRange.filter(isSuccessfulOrder).length;
      const canceledOrdersCount = ordersInRange.filter(isCanceledOrder).length;
      const pendingOrdersCount = Math.max(
        0,
        ordersInRange.length - successfulOrdersCount - canceledOrdersCount,
      );

      paidOrders.forEach((order) => {
        totalRevenue += parseFloat(order.total) || 0;

        const orderDate = new Date(order.timestamp);
        const orderRevenue = parseFloat(order.total) || 0;
        const paymentMethod = normalizePaymentMethod(order.paymentMethod);

        const paymentDistribution = paymentDistributionMap.get(
          paymentMethod.key,
        ) || {
          method: paymentMethod.key,
          name: paymentMethod.label,
          orders: 0,
          revenue: 0,
        };

        paymentDistribution.orders += 1;
        paymentDistribution.revenue += orderRevenue;
        paymentDistributionMap.set(paymentMethod.key, paymentDistribution);

        if (!Number.isNaN(orderDate.getTime())) {
          const dailyKey = formatDateKey(orderDate);
          pushRevenuePoint(dailyRevenueMap, dailyKey, {
            label: dailyLabelFormatter.format(orderDate),
            revenue: orderRevenue,
            sortKey: new Date(`${dailyKey}T00:00:00`).getTime(),
          });

          const weekStart = getWeekStart(orderDate);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekEnd.getDate() + 6);
          const weeklyKey = formatDateKey(weekStart);
          pushRevenuePoint(weeklyRevenueMap, weeklyKey, {
            label: `${dailyLabelFormatter.format(weekStart)} - ${dailyLabelFormatter.format(weekEnd)}`,
            revenue: orderRevenue,
            sortKey: weekStart.getTime(),
          });

          const monthStart = new Date(
            orderDate.getFullYear(),
            orderDate.getMonth(),
            1,
          );
          const monthlyKey = `${monthStart.getFullYear()}-${padNumber(monthStart.getMonth() + 1)}`;
          pushRevenuePoint(monthlyRevenueMap, monthlyKey, {
            label: monthLabelFormatter
              .format(orderDate)
              .replace(".", "")
              .replace(" de ", "/"),
            revenue: orderRevenue,
            sortKey: monthStart.getTime(),
          });
        }

        const parsedItems = parseJSON(order.items);
        const orderItems = Array.isArray(parsedItems) ? parsedItems : [];

        orderItems.forEach((item) => {
          const quantity = getItemQuantity(item);
          const salePrice = Number(item.price) || 0;
          const itemId = String(
            item.productId || item.id || item.name || "sem-id",
          );
          const itemMeta = productMetaMap.get(itemId);
          const itemName = item.name || itemMeta?.name || "Produto sem nome";
          const itemCategory = itemMeta?.category || item.category || "Outros";

          const unitCost = getUnitCostByItem(item);

          const itemRevenue = salePrice * quantity;
          const grossProfit = (salePrice - unitCost) * quantity;

          totalItemsSold += quantity;

          const existing = productSales.get(itemId) || {
            productId: itemId,
            name: itemName,
            category: itemCategory,
            quantitySold: 0,
            revenue: 0,
            grossProfit: 0,
            stock: itemMeta?.stock ?? null,
            minStock: itemMeta?.minStock || 0,
          };

          existing.quantitySold += quantity;
          existing.revenue += itemRevenue;
          existing.grossProfit += grossProfit;

          productSales.set(itemId, existing);

          const categoryEntry = categorySalesMap.get(itemCategory) || {
            category: itemCategory,
            quantitySold: 0,
            revenue: 0,
          };

          categoryEntry.quantitySold += quantity;
          categoryEntry.revenue += itemRevenue;
          categorySalesMap.set(itemCategory, categoryEntry);
        });
      });

      const outsourcedFinancialRows = await applyDateRange(
        db("outsourced_services").select(
          "id",
          "service_type",
          "fabric_paid_amount",
          "service_cost_amount",
          "started_at",
          "created_at",
        ),
        "started_at",
      );
      const expensesRows = await applyDateRange(
        db("management_expenses").select(
          "id",
          "description",
          "amount",
          "category",
          "expense_date",
        ),
        "expense_date",
      );

      const outsourcedMaterialRevenue = outsourcedFinancialRows.reduce(
        (sum, service) => sum + (Number(service.fabric_paid_amount) || 0),
        0,
      );
      const outsourcedServiceCosts = outsourcedFinancialRows.reduce(
        (sum, service) => sum + (Number(service.service_cost_amount) || 0),
        0,
      );
      const registeredExpensesTotal = expensesRows.reduce(
        (sum, expense) => sum + (Number(expense.amount) || 0),
        0,
      );
      const ecommerceGrossRevenue = totalRevenue;
      const grossRevenue = ecommerceGrossRevenue + outsourcedMaterialRevenue;
      const netProfit =
        grossRevenue - outsourcedServiceCosts - registeredExpensesTotal;

      const averageTicket = successfulOrdersCount
        ? totalRevenue / successfulOrdersCount
        : 0;
      const successRate = ordersInRange.length
        ? (successfulOrdersCount / ordersInRange.length) * 100
        : 0;
      const cancellationRate = ordersInRange.length
        ? (canceledOrdersCount / ordersInRange.length) * 100
        : 0;
      const pendingRate = ordersInRange.length
        ? (pendingOrdersCount / ordersInRange.length) * 100
        : 0;

      const products = Array.from(productSales.values())
        .sort(
          (a, b) => b.quantitySold - a.quantitySold || b.revenue - a.revenue,
        )
        .map((product) => ({
          ...product,
          revenue: Number(product.revenue.toFixed(2)),
          grossProfit: Number(product.grossProfit.toFixed(2)),
          stock: Number(product.stock) || 0,
          minStock: Number(product.minStock) || 0,
        }));

      const topProductsByVolume = products.slice(0, 10).map((product) => ({
        productId: product.productId,
        name: product.name,
        category: product.category || "Outros",
        quantitySold: product.quantitySold,
        revenue: Number(product.revenue.toFixed(2)),
      }));

      const totalRevenueForAbc = products.reduce(
        (sum, product) => sum + product.revenue,
        0,
      );
      let cumulativeShare = 0;
      const abcCurve = [...products]
        .sort((a, b) => b.revenue - a.revenue)
        .map((product, index) => {
          const revenueShare = totalRevenueForAbc
            ? (product.revenue / totalRevenueForAbc) * 100
            : 0;
          cumulativeShare += revenueShare;

          const normalizedCumulative = Math.min(100, cumulativeShare);
          let classification = "C";

          if (normalizedCumulative <= 80 || index === 0) {
            classification = "A";
          } else if (normalizedCumulative <= 95) {
            classification = "B";
          }

          return {
            productId: product.productId,
            name: product.name,
            category: product.category || "Outros",
            quantitySold: product.quantitySold,
            revenue: Number(product.revenue.toFixed(2)),
            revenueShare: Number(revenueShare.toFixed(2)),
            cumulativeShare: Number(normalizedCumulative.toFixed(2)),
            classification,
          };
        });

      const totalCategoryRevenue = Array.from(categorySalesMap.values()).reduce(
        (sum, category) => sum + category.revenue,
        0,
      );
      const categoryPerformance = Array.from(categorySalesMap.values())
        .sort((a, b) => b.revenue - a.revenue)
        .map((category) => ({
          category: category.category,
          quantitySold: category.quantitySold,
          revenue: Number(category.revenue.toFixed(2)),
          revenueShare: Number(
            (totalCategoryRevenue
              ? (category.revenue / totalCategoryRevenue) * 100
              : 0
            ).toFixed(2),
          ),
        }));

      const soldByProductMap = new Map();
      products.forEach((product) => {
        soldByProductMap.set(product.productId, {
          quantitySold: product.quantitySold,
          revenue: product.revenue,
        });
      });

      const stockAlerts = [];
      productRows.forEach((product) => {
        const productId = String(product.id);
        const stock = Number(product.stock) || 0;

        if (Number.isNaN(stock)) {
          return;
        }

        const soldInfo = soldByProductMap.get(productId) || {
          quantitySold: 0,
          revenue: 0,
        };

        const minStock = Number(product.minStock) || 0;
        const averageDailySales = soldInfo.quantitySold / periodDays;
        const safetyStock = Math.max(
          minStock,
          Math.ceil(averageDailySales * 7),
        );
        const daysToStockout =
          averageDailySales > 0 ? stock / averageDailySales : null;

        let severity = "";
        let alertType = "low_stock";
        if (stock < 0) {
          severity = "critical";
          alertType = "backorder";
        } else if (stock <= minStock) {
          severity = "critical";
        } else if (
          stock <= safetyStock ||
          (daysToStockout !== null && daysToStockout <= 7)
        ) {
          severity = "warning";
        }

        if (!severity) {
          return;
        }

        const recommendedStock = Math.max(
          safetyStock,
          Math.ceil(averageDailySales * 14),
        );
        const suggestedPurchase = Math.max(0, recommendedStock - stock);

        stockAlerts.push({
          productId,
          name: product.name || "Produto",
          category: product.category || "Outros",
          stock,
          minStock,
          safetyStock,
          quantitySold: soldInfo.quantitySold,
          revenue: Number((soldInfo.revenue || 0).toFixed(2)),
          averageDailySales: Number(averageDailySales.toFixed(2)),
          daysToStockout:
            daysToStockout === null ? null : Number(daysToStockout.toFixed(1)),
          suggestedPurchase,
          severity,
          alertType,
          isBackorder: alertType === "backorder",
          backorderQuantity: alertType === "backorder" ? Math.abs(stock) : 0,
          backorderNotice:
            alertType === "backorder" ? BACKORDER_NOTICE : null,
        });
      });

      const severityOrder = {
        critical: 0,
        warning: 1,
      };
      stockAlerts.sort((a, b) => {
        const severityDiff =
          severityOrder[a.severity] - severityOrder[b.severity];
        if (severityDiff !== 0) return severityDiff;

        const daysA =
          a.daysToStockout === null
            ? Number.POSITIVE_INFINITY
            : a.daysToStockout;
        const daysB =
          b.daysToStockout === null
            ? Number.POSITIVE_INFINITY
            : b.daysToStockout;
        if (daysA !== daysB) return daysA - daysB;

        return a.stock - b.stock;
      });

      const sortRevenueSeries = (seriesMap) =>
        Array.from(seriesMap.values())
          .sort((a, b) => a.sortKey - b.sortKey)
          .map((item) => ({
            label: item.label,
            revenue: Number(item.revenue.toFixed(2)),
            orders: item.orders,
          }));

      const paymentDistribution = Array.from(paymentDistributionMap.values())
        .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue)
        .map((item) => ({
          ...item,
          value: item.orders,
          revenue: Number(item.revenue.toFixed(2)),
        }));

      return res.json({
        success: true,
        summary: {
          totalOrders: successfulOrdersCount,
          totalOrderAttempts: ordersInRange.length,
          successfulOrders: successfulOrdersCount,
          canceledOrders: canceledOrdersCount,
          pendingOrders: pendingOrdersCount,
          totalItemsSold,
          ecommerceGrossRevenue: Number(ecommerceGrossRevenue.toFixed(2)),
          outsourcedMaterialRevenue: Number(
            outsourcedMaterialRevenue.toFixed(2),
          ),
          grossRevenue: Number(grossRevenue.toFixed(2)),
          outsourcedServiceCosts: Number(outsourcedServiceCosts.toFixed(2)),
          registeredExpenses: Number(registeredExpensesTotal.toFixed(2)),
          netProfit: Number(netProfit.toFixed(2)),
          totalRevenue: Number(grossRevenue.toFixed(2)),
          averageTicket: Number(averageTicket.toFixed(2)),
          successRate: Number(successRate.toFixed(2)),
          cancellationRate: Number(cancellationRate.toFixed(2)),
          pendingRate: Number(pendingRate.toFixed(2)),
        },
        finance: {
          ecommerceGrossRevenue: Number(ecommerceGrossRevenue.toFixed(2)),
          outsourcedMaterialRevenue: Number(
            outsourcedMaterialRevenue.toFixed(2),
          ),
          grossRevenue: Number(grossRevenue.toFixed(2)),
          outsourcedServiceCosts: Number(outsourcedServiceCosts.toFixed(2)),
          registeredExpenses: Number(registeredExpensesTotal.toFixed(2)),
          netProfit: Number(netProfit.toFixed(2)),
          outsourcedServices: outsourcedFinancialRows.map((service) => ({
            ...service,
            fabric_paid_amount: Number(service.fabric_paid_amount) || 0,
            service_cost_amount: Number(service.service_cost_amount) || 0,
          })),
          expenses: expensesRows.map((expense) => ({
            ...expense,
            amount: Number(expense.amount) || 0,
          })),
        },
        products,
        charts: {
          revenueEvolution: {
            daily: sortRevenueSeries(dailyRevenueMap),
            weekly: sortRevenueSeries(weeklyRevenueMap),
            monthly: sortRevenueSeries(monthlyRevenueMap),
          },
          paymentDistribution,
        },
        analytics: {
          periodDays,
          topProductsByVolume,
          abcCurve,
          categoryPerformance,
          stockAlerts,
        },
        filters: {
          startAt: startAt || null,
          endAt: endAt || null,
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Erro ao gerar relatório de gestão:", error);
      return res.status(500).json({
        error: "Erro ao gerar relatório de gestão",
        message: error.message,
      });
    }
  },
);

// CRUD de Produtos (Admin)

app.get(
  "/api/products",
  async (req, res) => {
    try {
      const catalogContext = await resolveCatalogContext(req);
      const products = await db("products").select("*").orderBy("id");
      const visibilityMap = await getProductVisibilityMap(
        products.map((product) => product.id),
      );
      const visibleProducts = await applyUserProductPrices(
        filterCatalogProducts(products, {
          ...catalogContext,
          visibilityMap,
        }),
        catalogContext.userId,
      );
      const visibilityPayloadMap = catalogContext.isAdminCatalog
        ? await getProductVisibilityPayloadMap(
            visibleProducts.map((product) => product.id),
          )
        : new Map();
      res.json(
        visibleProducts.map((product) =>
          normalizeProductResponse({
            ...product,
            visibleUserIds: visibilityPayloadMap.get(String(product.id)) || [],
          }),
        ),
      );
    } catch (e) {
      console.error("Erro ao buscar todos os produtos:", e);
      res.status(500).json({ error: "Erro ao buscar produtos" });
    }
  },
);

app.post(
  "/api/products",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const {
      id,
      name,
      price,
      priceRaw,
      category,
      imageUrl,
      images,
      videoUrl,
      popular,
      stock,
      minStock,
    } = req.body;

    if (!name || !price || !category) {
      return res
        .status(400)
        .json({ error: "Nome, preço e categoria são obrigatórios" });
    }

    try {
      const normalizedImages = Array.isArray(images)
        ? images
            .map((url) => (typeof url === "string" ? url.trim() : ""))
            .filter((url) => !!url)
        : [];
      const primaryImage =
        imageUrl || normalizedImages[0] || "https://picsum.photos/400/300";
      const productHidden = isTruthyDb(
        req.body.hidden ?? req.body.isHidden ?? req.body.hiddenProduct,
      );
      const visibleUserIds = getProductVisibleUserIdsFromBody(req.body);

      const newProduct = {
        id: id || `prod_${Date.now()}`,
        name,
        price: parseFloat(price),
        priceRaw: priceRaw !== undefined ? parseFloat(priceRaw) : 0,
        category,
        imageUrl: primaryImage,
        images: JSON.stringify(
          normalizedImages.length > 0 ? normalizedImages : [primaryImage],
        ),
        videoUrl: videoUrl || "",
        popular: popular || false,
        hidden: productHidden,
        stock: stock !== undefined && stock !== null ? toStockNumber(stock) : 0,
        minStock: minStock !== undefined ? parseInt(minStock) : 0,
        quantidadeVenda:
          req.body.quantidadeVenda !== undefined
            ? parseInt(req.body.quantidadeVenda)
            : 1,
      };

      await db.transaction(async (trx) => {
        await trx("products").insert(newProduct);
        await saveProductVisibility(
          newProduct.id,
          productHidden,
          visibleUserIds,
          trx,
        );
      });
      res.status(201).json(
        normalizeProductResponse({
          ...newProduct,
          visibleUserIds: productHidden ? visibleUserIds : [],
        }),
      );
    } catch (e) {
      console.error("Erro ao criar produto:", e);
      res.status(500).json({ error: "Erro ao criar produto" });
    }
  },
);

app.put(
  "/api/products/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    const {
      name,
      price,
      priceRaw,
      category,
      imageUrl,
      images,
      videoUrl,
      popular,
      stock,
      minStock,
      active,
    } = req.body;

    try {
      // MULTI-TENANCY: Busca produto apenas da loja específica
      const exists = await db("products").where({ id }).first();
      if (!exists) {
        return res
          .status(404)
          .json({ error: "Produto não encontrado nesta loja" });
      }

      const updates = {};
      if (name !== undefined) updates.name = name;
      if (price !== undefined) updates.price = parseFloat(price);
      if (priceRaw !== undefined) updates.priceRaw = parseFloat(priceRaw);
      if (category !== undefined) updates.category = category;
      if (imageUrl !== undefined) {
        updates.imageUrl = imageUrl;
      }
      if (images !== undefined) {
        const normalizedImages = Array.isArray(images)
          ? images
              .map((url) => (typeof url === "string" ? url.trim() : ""))
              .filter((url) => !!url)
          : [];
        updates.images = JSON.stringify(normalizedImages);
        updates.imageUrl = normalizedImages[0] || imageUrl || "";
      }
      if (videoUrl !== undefined) updates.videoUrl = videoUrl;
      if (popular !== undefined) updates.popular = popular;
      if (stock !== undefined)
        updates.stock = stock === null ? 0 : toStockNumber(stock);

      if (minStock !== undefined) updates.minStock = parseInt(minStock);
      if (active !== undefined) updates.active = !!active;

      const hasHiddenPayload =
        req.body.hidden !== undefined ||
        req.body.isHidden !== undefined ||
        req.body.hiddenProduct !== undefined;
      const hasVisibleUsersPayload =
        req.body.visibleUserIds !== undefined ||
        req.body.allowedUserIds !== undefined ||
        req.body.clientIds !== undefined ||
        req.body.clients !== undefined ||
        req.body.users !== undefined;
      const nextHidden = hasHiddenPayload
        ? isTruthyDb(req.body.hidden ?? req.body.isHidden ?? req.body.hiddenProduct)
        : isHiddenProduct(exists);
      const currentVisibility = hasVisibleUsersPayload
        ? null
        : await getProductVisibilityMap([id]);
      const visibleUserIds = hasVisibleUsersPayload
        ? getProductVisibleUserIdsFromBody(req.body)
        : [...(currentVisibility.get(String(id)) || [])];

      if (hasHiddenPayload) updates.hidden = nextHidden;

      if (req.body.quantidadeVenda !== undefined)
        updates.quantidadeVenda = parseInt(req.body.quantidadeVenda);
      // Só atualiza se houver campos para atualizar
      if (Object.keys(updates).length === 0 && !hasVisibleUsersPayload) {
        return res.status(400).json({ error: "Nenhum campo para atualizar." });
      }

      await db.transaction(async (trx) => {
        if (Object.keys(updates).length > 0) {
          await trx("products").where({ id }).update(updates);
        }
        if (hasHiddenPayload || hasVisibleUsersPayload) {
          await saveProductVisibility(id, nextHidden, visibleUserIds, trx);
        }
      });

      const updated = await db("products").where({ id }).first();
      const updatedVisibility = await getProductVisibilityPayloadMap([id]);
      res.json(
        normalizeProductResponse({
          ...updated,
          visibleUserIds: updatedVisibility.get(String(id)) || [],
        }),
      );
    } catch (e) {
      console.error("Erro ao atualizar produto:", e);
      res.status(500).json({ error: "Erro ao atualizar produto" });
    }
  },
);

app.delete(
  "/api/products/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;

    try {
      // MULTI-TENANCY: Busca produto apenas da loja específica
      const exists = await db("products").where({ id }).first();
      if (!exists) {
        return res
          .status(404)
          .json({ error: "Produto não encontrado nesta loja" });
      }

      // MULTI-TENANCY: Deleta apenas se pertencer à loja
      await db("products").where({ id }).del();
      res.json({ success: true, message: "Produto deletado com sucesso" });
    } catch (e) {
      console.error("Erro ao deletar produto:", e);
      res.status(500).json({ error: "Erro ao deletar produto" });
    }
  },
);

// ========== CRUD DE CATEGORIAS (Single-tenant) ==========

// Listar categorias
app.get("/api/categories", async (req, res) => {
  try {
    const catalogMode =
      req.query.catalog === "true" || req.query.mode === "catalog";
    const hasFullAccess = catalogMode
      ? await resolveCatalogFullAccess(req)
      : true;

    const categoriesFromTable = await db("categories")
      .select("id", "name", "icon", "order", "created_at")
      .orderBy("order", "asc")
      .orderBy("name", "asc");

    const productCategoryQuery = db("products")
      .distinct("category")
      .whereNotNull("category")
      .whereNot("category", "");

    if (catalogMode) {
      productCategoryQuery.where({ active: true });
    }

    const categoriesFromProducts = await productCategoryQuery;
    const categoriesByName = new Map();

    categoriesFromTable.forEach((category) => {
      categoriesByName.set(normalizeCategoryName(category.name), category);
    });

    categoriesFromProducts.forEach(({ category }) => {
      const categoryName = String(category || "").trim();
      const normalizedName = normalizeCategoryName(categoryName);
      if (!categoryName || categoriesByName.has(normalizedName)) return;

      categoriesByName.set(normalizedName, {
        id: makeCategoryIdFromName(categoryName),
        name: categoryName,
        icon: "📦",
        order: 999,
        created_at: null,
        source: "products",
      });
    });

    const categories = Array.from(categoriesByName.values()).sort((a, b) => {
      const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
      if (orderDiff !== 0) return orderDiff;
      return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR");
    });

    const visibleCategories = hasFullAccess
      ? categories
      : categories.filter(
          (category) => normalizeCategoryName(category.name) !== IMPORTED_CATEGORY_NAME,
        );
    res.json(visibleCategories);
  } catch (e) {
    console.error("❌ Erro ao buscar categorias:", e);
    res.status(500).json({ error: "Erro ao buscar categorias" });
  }
});

// Criar nova categoria
app.post(
  "/api/categories",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { name, icon, order } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Nome da categoria é obrigatório" });
    }
    try {
      // Verifica se categoria já existe
      const exists = await db("categories")
        .where({ name: name.trim() })
        .first();
      if (exists) {
        return res.status(409).json({
          error: "Categoria já existe",
          category: exists,
        });
      }
      const newCategory = {
        id: `cat_${Date.now()}`,
        name: name.trim(),
        icon: icon || "📦",
        order: order || 0,
      };
      await db("categories").insert(newCategory);
      res.status(201).json(newCategory);
    } catch (e) {
      console.error("❌ Erro ao criar categoria:", e);
      res.status(500).json({ error: "Erro ao criar categoria" });
    }
  },
);

// Atualizar categoria
app.put(
  "/api/categories/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { name, icon, order } = req.body;
    try {
      // Verifica se categoria existe
      const exists = await db("categories").where({ id }).first();
      if (!exists) {
        return res.status(404).json({ error: "Categoria não encontrada" });
      }
      const updates = {};
      if (name !== undefined) updates.name = name.trim();
      if (icon !== undefined) updates.icon = icon;
      if (order !== undefined) updates.order = order;
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "Nenhum campo para atualizar" });
      }
      await db("categories").where({ id }).update(updates);
      const updated = await db("categories").where({ id }).first();
      res.json(updated);
    } catch (e) {
      console.error("❌ Erro ao atualizar categoria:", e);
      res.status(500).json({ error: "Erro ao atualizar categoria" });
    }
  },
);

// Deletar categoria
app.delete(
  "/api/categories/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    try {
      // Verifica se categoria existe
      const exists = await db("categories").where({ id }).first();
      if (!exists) {
        return res.status(404).json({ error: "Categoria não encontrada" });
      }
      // Verifica se há produtos usando essa categoria
      const productsCount = await db("products")
        .where({ category: exists.name })
        .count("id as count")
        .first();
      if (Number(productsCount.count) > 0) {
        return res.status(409).json({
          error: `Não é possível deletar. Existem ${productsCount.count} produtos usando esta categoria.`,
          productsCount: Number(productsCount.count),
        });
      }
      await db("categories").where({ id }).del();
      res.json({ success: true, message: "Categoria deletada com sucesso" });
    } catch (e) {
      console.error("❌ Erro ao deletar categoria:", e);
      res.status(500).json({ error: "Erro ao deletar categoria" });
    }
  },
);

// Verificar se CPF ou CNPJ existe (POST)
app.post("/api/users/check-cpf", async (req, res) => {
  try {
    const { cpf } = req.body;
    const docClean = String(cpf).replace(/\D/g, "");
    if (docClean.length !== 11 && docClean.length !== 14) {
      return res
        .status(400)
        .json({ error: "Documento inválido. Digite 11 ou 14 dígitos." });
    }
    const user = await db("users").where({ cpf: docClean }).first();
    if (user) {
      return res.json({ exists: true, user: normalizeUserResponse(user) });
    } else {
      return res.json({ exists: false, requiresRegistration: true });
    }
  } catch (e) {
    console.error("❌ Erro ao verificar documento:", e);
    res.status(500).json({ error: "Erro ao verificar documento" });
  }
});

// Buscar usuário por CPF ou CNPJ
app.get("/api/users/cpf/:cpf", async (req, res) => {
  try {
    const docClean = String(req.params.cpf).replace(/\D/g, "");

    // Aceita tanto 11 (CPF) quanto 14 (CNPJ)
    if (docClean.length !== 11 && docClean.length !== 14) {
      return res
        .status(400)
        .json({ error: "Documento inválido. Digite 11 ou 14 dígitos." });
    }

    const user = await db("users").where({ cpf: docClean }).first();

    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }

    res.json(normalizeUserResponse(user));
  } catch (e) {
    console.error("❌ Erro ao buscar usuário por documento:", e);
    res.status(500).json({ error: "Erro ao buscar usuário" });
  }
});

app.get("/api/users", authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const users = await db("users").select("*");

    // Mapeia os usuários garantindo que o histórico seja sempre um objeto/array válido
    const formattedUsers = users.map(normalizeUserResponse);

    res.json(formattedUsers);
  } catch (e) {
    console.error("❌ Erro ao listar usuários:", e);
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

app.patch(
  "/api/users/:id/full-access",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { fullAccess } = req.body;

    if (typeof fullAccess === "undefined") {
      return res.status(400).json({ error: "fullAccess é obrigatório" });
    }

    try {
      const user = await db("users").where({ id }).first();
      if (!user) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }

      await db("users").where({ id }).update({
        fullAccess: isTruthyDb(fullAccess),
      });

      const updatedUser = await db("users").where({ id }).first();
      res.json({
        success: true,
        user: normalizeUserResponse(updatedUser),
      });
    } catch (e) {
      console.error("Erro ao atualizar acesso completo:", e);
      res.status(500).json({ error: "Erro ao atualizar acesso completo" });
    }
  },
);

app.patch(
  "/api/users/:id/monthly-payment",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { monthlyPayment } = req.body;

    if (typeof monthlyPayment === "undefined") {
      return res.status(400).json({ error: "monthlyPayment é obrigatório" });
    }

    try {
      const user = await db("users").where({ id }).first();
      if (!user) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }

      await db("users").where({ id }).update({
        monthlyPayment: isTruthyDb(monthlyPayment),
      });

      const updatedUser = await db("users").where({ id }).first();
      res.json({
        success: true,
        user: normalizeUserResponse(updatedUser),
      });
    } catch (e) {
      console.error("Erro ao atualizar pagamento mensal:", e);
      res.status(500).json({ error: "Erro ao atualizar pagamento mensal" });
    }
  },
);

app.get(
  "/api/users/:id/product-prices",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const payload = await getUserProductPricesPayload(req.params.id);
      res.json(payload);
    } catch (e) {
      console.error("Erro ao buscar preços personalizados:", e);
      res
        .status(e.statusCode || 500)
        .json({ error: e.message || "Erro ao buscar preços personalizados" });
    }
  },
);

app.put(
  "/api/users/:id/product-prices",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { prices } = req.body;

    if (!Array.isArray(prices)) {
      return res.status(400).json({
        error: "prices deve ser uma lista de { productId, price }",
      });
    }

    try {
      const user = await db("users").where({ id }).first();
      if (!user) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }

      const productIds = [
        ...new Set(prices.map((item) => String(item?.productId || ""))),
      ].filter(Boolean);

      if (productIds.length === 0) {
        return res.status(400).json({ error: "Informe ao menos um produto" });
      }

      const existingProducts = await db("products").whereIn("id", productIds);
      const existingIds = new Set(existingProducts.map((product) => product.id));
      const missingIds = productIds.filter((productId) => !existingIds.has(productId));
      if (missingIds.length > 0) {
        return res.status(404).json({
          error: `Produto(s) não encontrado(s): ${missingIds.join(", ")}`,
        });
      }

      const now = new Date();
      await db.transaction(async (trx) => {
        for (const item of prices) {
          const productId = String(item?.productId || "");
          if (!productId) continue;

          if (item.price === null || item.price === undefined || item.price === "") {
            await trx("user_product_prices")
              .where({ userId: id, productId })
              .del();
            continue;
          }

          const price = normalizePriceValue(item.price);
          if (price === null) {
            throw validationError(
              `Preço inválido para o produto ${productId}. Use valor maior ou igual a zero.`,
            );
          }

          await trx("user_product_prices")
            .insert({
              userId: id,
              productId,
              price,
              created_at: now,
              updated_at: now,
            })
            .onConflict(["userId", "productId"])
            .merge({
              price,
              updated_at: now,
            });
        }
      });

      const payload = await getUserProductPricesPayload(id);
      res.json({ success: true, ...payload });
    } catch (e) {
      console.error("Erro ao salvar preços personalizados:", e);
      res.status(e.statusCode || 500).json({
        error: e.message || "Erro ao salvar preços personalizados",
      });
    }
  },
);

app.put(
  "/api/users/:id/product-prices/:productId",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id, productId } = req.params;
    const { price } = req.body;

    try {
      const user = await db("users").where({ id }).first();
      if (!user) {
        return res.status(404).json({ error: "Usuário não encontrado" });
      }

      const product = await db("products").where({ id: productId }).first();
      if (!product) {
        return res.status(404).json({ error: "Produto não encontrado" });
      }

      const normalizedPrice = normalizePriceValue(price);
      if (normalizedPrice === null) {
        return res.status(400).json({
          error: "Preço inválido. Use valor maior ou igual a zero.",
        });
      }

      const now = new Date();
      await db("user_product_prices")
        .insert({
          userId: id,
          productId,
          price: normalizedPrice,
          created_at: now,
          updated_at: now,
        })
        .onConflict(["userId", "productId"])
        .merge({
          price: normalizedPrice,
          updated_at: now,
        });

      const payload = await getUserProductPricesPayload(id);
      res.json({ success: true, ...payload });
    } catch (e) {
      console.error("Erro ao salvar preço personalizado:", e);
      res.status(500).json({
        error: e.message || "Erro ao salvar preço personalizado",
      });
    }
  },
);

app.delete(
  "/api/users/:id/product-prices/:productId",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id, productId } = req.params;

    try {
      await db("user_product_prices").where({ userId: id, productId }).del();
      const payload = await getUserProductPricesPayload(id);
      res.json({ success: true, ...payload });
    } catch (e) {
      console.error("Erro ao remover preço personalizado:", e);
      res.status(e.statusCode || 500).json({
        error: e.message || "Erro ao remover preço personalizado",
      });
    }
  },
);

app.get("/api/delivery-methods", (req, res) => {
  res.json(Object.values(DELIVERY_METHODS));
});

app.get("/api/shipping-carriers", async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const query = db("shipping_carriers").select("*");
    if (!includeInactive) query.where({ active: true });

    const carriers = await query.orderBy("name", "asc");
    res.json(carriers.map(normalizeShippingCarrier));
  } catch (e) {
    console.error("Erro ao listar transportadoras:", e);
    res.status(500).json({ error: "Erro ao listar transportadoras" });
  }
});

app.post(
  "/api/shipping-carriers",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id, name, trackingUrl, active } = req.body;
    const trimmedName = String(name || "").trim();

    if (!trimmedName) {
      return res.status(400).json({ error: "Nome da transportadora é obrigatório" });
    }

    try {
      const carrierId =
        id ||
        `carrier_${trimmedName
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")}_${Date.now()}`;

      const carrier = {
        id: carrierId,
        name: trimmedName,
        trackingUrl: trackingUrl ? String(trackingUrl).trim() : null,
        active: active === undefined ? true : isTruthyDb(active),
        created_at: new Date(),
        updated_at: new Date(),
      };

      await db("shipping_carriers").insert(carrier);
      res.status(201).json(normalizeShippingCarrier(carrier));
    } catch (e) {
      console.error("Erro ao cadastrar transportadora:", e);
      res.status(500).json({ error: "Erro ao cadastrar transportadora" });
    }
  },
);

app.put(
  "/api/shipping-carriers/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { name, trackingUrl, active } = req.body;

    try {
      const carrier = await db("shipping_carriers").where({ id }).first();
      if (!carrier) {
        return res.status(404).json({ error: "Transportadora não encontrada" });
      }

      const updates = { updated_at: new Date() };
      if (name !== undefined) {
        const trimmedName = String(name || "").trim();
        if (!trimmedName) {
          return res.status(400).json({ error: "Nome da transportadora é obrigatório" });
        }
        updates.name = trimmedName;
      }
      if (trackingUrl !== undefined) {
        updates.trackingUrl = trackingUrl ? String(trackingUrl).trim() : null;
      }
      if (active !== undefined) updates.active = isTruthyDb(active);

      await db("shipping_carriers").where({ id }).update(updates);
      const updated = await db("shipping_carriers").where({ id }).first();
      res.json(normalizeShippingCarrier(updated));
    } catch (e) {
      console.error("Erro ao atualizar transportadora:", e);
      res.status(500).json({ error: "Erro ao atualizar transportadora" });
    }
  },
);

app.delete(
  "/api/shipping-carriers/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;

    try {
      const carrier = await db("shipping_carriers").where({ id }).first();
      if (!carrier) {
        return res.status(404).json({ error: "Transportadora não encontrada" });
      }

      await db("shipping_carriers").where({ id }).update({
        active: false,
        updated_at: new Date(),
      });

      const updated = await db("shipping_carriers").where({ id }).first();
      res.json({
        success: true,
        carrier: normalizeShippingCarrier(updated),
      });
    } catch (e) {
      console.error("Erro ao desativar transportadora:", e);
      res.status(500).json({ error: "Erro ao desativar transportadora" });
    }
  },
);

// Endpoint para listar todos os produtos (admin)
app.get(
  "/api/products",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const products = await db("products").select("*").orderBy("id");
      const visibilityPayloadMap = await getProductVisibilityPayloadMap(
        products.map((product) => product.id),
      );
      res.json(
        products.map((product) =>
          normalizeProductResponse({
            ...product,
            visibleUserIds: visibilityPayloadMap.get(String(product.id)) || [],
          }),
        ),
      );
    } catch (e) {
      console.error("Erro ao buscar todos os produtos:", e);
      res.status(500).json({ error: "Erro ao buscar produtos" });
    }
  },
);

// ========== PASSO 1: Verificar se CPF existe (NÃO cria usuário) ==========
// ========== VERIFICAR EXISTÊNCIA DE CPF/CNPJ ===========
app.post("/api/", async (req, res) => {
  const { cpf } = req.body;
  const docClean = String(cpf).replace(/\D/g, "");

  if (docClean.length !== 11 && docClean.length !== 14) {
    return res.status(400).json({ error: "Documento inválido" });
  }

  try {
    const user = await db("users").where({ cpf: docClean }).first();

    if (user) {
      return res.json({
        exists: true,
        user: { id: user.id, name: user.name, cpf: user.cpf },
      });
    } else {
      return res.json({ exists: false, requiresRegistration: true });
    }
  } catch (e) {
    res.status(500).json({ error: "Erro ao consultar banco de dados" });
  }
});

// ========== PASSO 2: Cadastrar novo usuário (APENAS se não existir) ==========
app.post("/api/users/register", async (req, res) => {
  const { cpf, name, email, cep, address, phone, password } = req.body;
  console.log(`📝 [REGISTER] Nome: ${name}, Documento: ${cpf}`);

  // Validação de campos obrigatórios
  if (!cpf || !name || !email || !cep || !address || !phone || !password) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios" });
  }

  const docClean = String(cpf).replace(/\D/g, "");

  // AJUSTE: Aceita 11 (CPF) ou 14 (CNPJ)
  if (docClean.length !== 11 && docClean.length !== 14) {
    return res.status(400).json({
      error: "Documento inválido. Digite 11 dígitos para CPF ou 14 para CNPJ.",
    });
  }

  try {
    // Verifica se já existe
    const exists = await db("users").where({ cpf: docClean }).first();

    if (exists) {
      console.log(`⚠️ Tentativa de cadastro duplicado: ${docClean}`);
      return res.status(409).json({
        error: "Este documento já está cadastrado",
        user: normalizeUserResponse(exists),
      });
    }

    // Cria novo usuário
    console.log(`📝 Cadastrando novo usuário: ${name} (${docClean})`);

    const newUser = {
      password: password, // Lembrete: considere usar bcrypt no futuro para segurança
      id: `user_${Date.now()}`,
      name: name.trim(),
      email: email.trim(),
      cpf: docClean, // Armazenamos o CNPJ aqui normalmente
      cep: cep.trim(),
      address: address.trim(),
      phone: phone.trim(),
      historico: JSON.stringify([]),
      pontos: 0,
      role: "customer",
      fullAccess: false,
      monthlyPayment: false,
    };

    await db("users").insert(newUser);

    console.log(`✅ Usuário cadastrado com sucesso: ${newUser.id}`);

    res.status(201).json({
      success: true,
      user: normalizeUserResponse(newUser),
    });
  } catch (e) {
    console.error("❌ Erro ao cadastrar usuário:", e);
    res.status(500).json({ error: "Erro ao cadastrar usuário" });
  }
});

app.post("/api/users", async (req, res) => {
  const { cpf, name, email, id } = req.body;

  if (!cpf)
    return res.status(400).json({ error: "Documento (CPF/CNPJ) obrigatório" });

  const docClean = String(cpf).replace(/\D/g, "");

  // Validação para aceitar 11 ou 14 dígitos
  if (docClean.length !== 11 && docClean.length !== 14) {
    return res.status(400).json({
      error: "Documento inválido. Use 11 dígitos para CPF ou 14 para CNPJ.",
    });
  }

  try {
    // Verifica se usuário já existe (usando o documento limpo)
    const exists = await db("users").where({ cpf: docClean }).first();

    if (exists) {
      console.log(
        `ℹ️ Documento ${docClean} já cadastrado - retornando usuário existente`,
      );
      return res.json({
        ...normalizeUserResponse(exists),
        message: "Usuário já existe - login realizado",
      });
    }

    // Cria novo usuário
    const newUser = {
      id: id || `user_${Date.now()}`,
      name: name || "Sem Nome",
      email: email || "",
      cpf: docClean,
      historico: JSON.stringify([]),
      pontos: 0,
      role: "customer", // Adicionado para manter consistência com outros cadastros
      fullAccess: false,
      monthlyPayment: false,
    };

    await db("users").insert(newUser);

    console.log(`✅ Novo usuário (Doc: ${docClean}) criado com sucesso.`);
    res.status(201).json(normalizeUserResponse(newUser));
  } catch (e) {
    console.error("❌ Erro ao salvar usuário:", e);
    res.status(500).json({ error: "Erro ao salvar usuário" });
  }
});

// ========== DEBUG: Endpoint temporário para ver TODOS os pedidos ==========
app.get("/api/debug/orders", async (req, res) => {
  try {
    const allOrders = await db("orders")
      .select("id", "status", "paymentStatus", "timestamp")
      .orderBy("timestamp", "desc")
      .limit(20);

    console.log(`🔍 [DEBUG] Total de pedidos no banco: ${allOrders.length}`);

    const summary = {
      total: allOrders.length,
      porStatus: {},
      pedidos: allOrders,
    };

    allOrders.forEach((order) => {
      // Conta por status
      const statusKey = `${order.status}/${order.paymentStatus}`;
      summary.porStatus[statusKey] = (summary.porStatus[statusKey] || 0) + 1;
    });

    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get(
  "/api/orders",
  authenticateToken,
  authorizeKitchen,
  async (req, res) => {
    console.log(`🍳 [GET /api/orders] Requisição recebida!`);
    console.log(`🍳 [GET /api/orders] user role: ${req.user?.role}`);

    try {
      // SINGLE-TENANT: Retorna todos os pedidos pagos e ativos
      const orders = await db("orders")
        .whereIn("status", ["active", "preparing"])
        .whereIn("paymentStatus", ["paid", "authorized"])
        .orderBy("timestamp", "asc");

      console.log(`🍳 Cozinha: ${orders.length} pedido(s) PAGOS na fila`);

      if (orders.length > 0) {
        console.log(`📋 IDs dos pedidos:`, orders.map((o) => o.id).join(", "));
      }

      res.json(
        orders.map((o) => normalizeOrderResponse(o)),
      );
    } catch (e) {
      res.status(500).json({ error: "Erro ao buscar pedidos" });
    }
  },
);

app.post("/api/orders", async (req, res) => {
  const {
    userId,
    userName,
    userDoc,
    items,
    total,
    paymentId,
    observation,
    paymentType,
    paymentMethod,
    installments,
    fee,
    deliveryMethod,
    carrierId,
  } = req.body;

  try {
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Itens do pedido são obrigatórios" });
    }

    const trimmedUserName = String(userName || "").trim();
    const effectiveUserId = userId || `guest_${Date.now()}`;
    const normalizedDeliveryMethod = normalizeDeliveryMethod(deliveryMethod);
    const deliveryMeta = getDeliveryMethodMeta(normalizedDeliveryMethod);

    if (!userId && !trimmedUserName) {
      return res.status(400).json({
        error: "Nome obrigatório para comprar sem cadastro",
      });
    }

    if (carrierId && deliveryMeta.value !== "carrier") {
      return res.status(400).json({
        error: "carrierId só pode ser informado quando a entrega for transportadora",
      });
    }

    // Iniciamos uma transação para garantir integridade dos dados
    await db.transaction(async (trx) => {
      // 1. Garante que o usuário existe
      const userExists = await trx("users").where({ id: effectiveUserId }).first();
      if (!userExists) {
        await trx("users").insert({
          id: effectiveUserId,
          name: trimmedUserName,
          email: null,
          cpf: userDoc ? String(userDoc).replace(/\D/g, "") : null, // Salva o CPF/CNPJ aqui!
          historico: "[]",
          pontos: 0,
          role: "customer",
          fullAccess: false,
          monthlyPayment: false,
        });
      }
      const currentUser =
        userExists || (await trx("users").where({ id: effectiveUserId }).first());
      const currentUserHasFullAccess = userHasFullAccess(currentUser);
      const currentUserHasMonthlyPayment = userHasMonthlyPayment(currentUser);
      const isMonthlyDeferredOrder = isMonthlyDeferredPayment(
        paymentType,
        paymentMethod,
      );

      if (isMonthlyDeferredOrder && !currentUserHasMonthlyPayment) {
        throw validationError(
          "Pagamento a prazo permitido apenas para clientes com pagamento mensal ativo.",
        );
      }

      let selectedCarrierId = null;
      if (carrierId && deliveryMeta.value === "carrier") {
        const carrier = await trx("shipping_carriers")
          .where({ id: carrierId, active: true })
          .first();
        if (!carrier) {
          throw validationError("Transportadora não encontrada ou inativa.");
        }
        selectedCarrierId = carrier.id;
      }

      // 2. Checagem de existencia e calculo de sob encomenda
      const productsById = new Map();
      for (const item of items) {
        const productId = getItemProductId(item);
        if (!productId) {
          throw new Error("Item do pedido sem ID de produto.");
        }

        const product = await trx("products").where({ id: productId }).first();
        if (!product) {
          throw new Error(`Produto ${productId} não encontrado no estoque!`);
        }
        if (isImportedProduct(product) && !currentUserHasFullAccess) {
          throw new Error(
            `Produto ${product.name || productId} exige acesso completo para compra.`,
          );
        }
        if (isHiddenProduct(product)) {
          const allowedUsers = await getProductVisibilityMap([productId], trx);
          if (!allowedUsers.get(String(productId))?.has(String(effectiveUserId))) {
            throw new Error(
              `Produto ${product.name || productId} nao esta disponivel para este cliente.`,
            );
          }
        }
        productsById.set(String(productId), product);
      }

      // 3. Garante precoBruto em todos os itens
      const userProductPriceMap = await getUserProductPriceMap(
        effectiveUserId,
        items.map((item) => getItemProductId(item)).filter(Boolean),
        trx,
      );
      const itemsWithPrecoBruto = Array.isArray(items)
        ? items.map((item) => {
            const productId = getItemProductId(item);
            const quantity = getItemQuantity(item);
            const product = productsById.get(String(productId));
            const backorderMeta = getBackorderMeta(product, quantity);
            const customPrice = userProductPriceMap.get(String(productId));
            const basePrice = Number(product?.price) || 0;
            const effectivePrice = customPrice
              ? customPrice.customPrice
              : item.price !== undefined
                ? Number(item.price)
                : basePrice;

            return {
              ...item,
              id: productId,
              productId,
              price: Number.isFinite(effectivePrice) ? effectivePrice : basePrice,
              basePrice,
              customPrice: customPrice?.customPrice ?? null,
              hasCustomPrice: !!customPrice,
              quantity,
              precoBruto:
                item.precoBruto !== undefined ? Number(item.precoBruto) : 0,
              stockAtOrder: Number(product?.stock) || 0,
              stockAvailableAtOrder: backorderMeta.stockAvailable,
              isBackorder: backorderMeta.isBackorder,
              backorderQuantity: backorderMeta.backorderQuantity,
              backorderNotice: backorderMeta.backorderNotice,
            };
          })
        : [];
      const computedOrderTotal = itemsWithPrecoBruto.reduce(
        (sum, item) =>
          sum + (Number(item.price) || 0) * getItemQuantity(item, 0),
        0,
      );
      const hasBackorder = itemsWithPrecoBruto.some((item) => item.isBackorder);
      const stockMovements = await adjustStockForOrderItems(
        trx,
        itemsWithPrecoBruto,
        -1,
      );
      stockMovements.forEach((movement) => {
        console.log(
          `  ✅ [Pedido] ${movement.name}: ${movement.stockBefore} → ${movement.stockAfter} (-${movement.quantity})`,
        );
      });
      const stockControlledItems = itemsWithPrecoBruto.filter(
        (item) => item.stockAtOrder !== null && item.stockAtOrder !== undefined,
      );
      if (stockMovements.length < stockControlledItems.length) {
        const movedProductIds = new Set(
          stockMovements.map((movement) => String(movement.productId)),
        );
        const missingProductIds = stockControlledItems
          .map((item) => getItemProductId(item))
          .filter((productId) => !movedProductIds.has(String(productId)));

        throw new Error(
          `Falha ao baixar estoque dos produtos: ${missingProductIds.join(", ")}`,
        );
      }

      const newOrder = {
        id: `order_${Date.now()}`,
        userId: effectiveUserId,
        userName: trimmedUserName || currentUser?.name || "Cliente",
        total: Number(computedOrderTotal.toFixed(2)),
        timestamp: new Date().toISOString(),
        status: isMonthlyDeferredOrder ? "active" : "pending",
        paymentStatus: isMonthlyDeferredOrder ? "monthly_pending" : "pending",
        paymentId: paymentId || null,
        paymentType: paymentType || null,
        paymentMethod: isMonthlyDeferredOrder ? "a_prazo" : paymentMethod || null,
        items: JSON.stringify(itemsWithPrecoBruto),
        observation: observation || null,
        hasBackorder,
        backorderNotice: hasBackorder ? BACKORDER_NOTICE : null,
        stockDeducted: stockMovements.length > 0,
        installments: installments || null,
        fee: fee || null,
        monthlyBilling: isMonthlyDeferredOrder,
        monthlyBillingMonth: isMonthlyDeferredOrder ? toYearMonth() : null,
        monthlyClosedAt: null,
        monthlyClosedBy: null,
        deliveryMethod: deliveryMeta.value,
        carrierId: selectedCarrierId,
        separationChecklist: null,
        separationChecklistUpdatedAt: null,
        created_at: new Date(),
      };

      // 4. Salva o pedido
      await trx("orders").insert(newOrder);

      // 5. Salva os itens do pedido na tabela order_products
      if (itemsWithPrecoBruto.length > 0) {
        const orderProducts = itemsWithPrecoBruto.map((item) => ({
          order_id: newOrder.id,
          product_id: getItemProductId(item),
          quantity: getItemQuantity(item),
          price: item.price !== undefined ? item.price : 0,
        }));
        await trx("order_products").insert(orderProducts);
      }

      console.log(`✅ Pedido ${newOrder.id} criado com sucesso!`);
      res.status(201).json({ ...newOrder, items: itemsWithPrecoBruto });
    });
  } catch (e) {
    console.error("❌ Erro ao salvar pedido:", e);
    res
      .status(e.statusCode || 500)
      .json({ error: e.message || "Erro ao salvar ordem" });
  }
});

// Buscar pedidos do usuário pelo userId
app.get("/api/users/:userId/orders", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "userId obrigatório" });
    const orders = await db("orders")
      .where({ userId })
      .orderBy("timestamp", "desc");
    const enrichedOrders = await enrichOrdersWithDelivery(orders);
    res.json(
      enrichedOrders.map((order) => normalizeOrderResponse(order)),
    );
  } catch (e) {
    console.error("❌ Erro ao buscar pedidos do usuário:", e);
    res.status(500).json({ error: "Erro ao buscar pedidos do usuário" });
  }
});

app.patch(
  "/api/orders/:id/delivery",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { deliveryMethod, carrierId } = req.body;

    try {
      const order = await db("orders").where({ id }).first();
      if (!order) {
        return res.status(404).json({ error: "Pedido não encontrado" });
      }

      const method = getDeliveryMethodMeta(
        deliveryMethod === undefined ? order.deliveryMethod : deliveryMethod,
      );
      let nextCarrierId = null;

      if (method.value === "carrier") {
        if (carrierId) {
          const carrier = await db("shipping_carriers")
            .where({ id: carrierId, active: true })
            .first();
          if (!carrier) {
            return res
              .status(400)
              .json({ error: "Transportadora não encontrada ou inativa" });
          }
          nextCarrierId = carrier.id;
        } else if (deliveryMethod === undefined && order.carrierId) {
          nextCarrierId = order.carrierId;
        }
      }

      await db("orders").where({ id }).update({
        deliveryMethod: method.value,
        carrierId: nextCarrierId,
      });

      const updated = await db("orders").where({ id }).first();
      const [enriched] = await enrichOrdersWithDelivery([updated]);
      res.json({
        success: true,
        order: normalizeOrderResponse(enriched),
      });
    } catch (e) {
      console.error("Erro ao atualizar entrega do pedido:", e);
      res.status(500).json({ error: "Erro ao atualizar entrega do pedido" });
    }
  },
);

app.post("/api/users/:userId/monthly-closing", async (req, res) => {
  const { userId } = req.params;
  const { month, closedBy } = req.body || {};

  try {
    const user = await db("users").where({ id: userId }).first();
    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }
    if (!userHasMonthlyPayment(user)) {
      return res.status(400).json({
        error: "Cliente não está com pagamento mensal ativo",
      });
    }

    const monthRange = getMonthRange(month || toYearMonth());
    const closedAt = new Date();

    const updatedCount = await db("orders")
      .where({ userId })
      .where("timestamp", ">=", monthRange.startIso)
      .where("timestamp", "<", monthRange.endIso)
      .whereNotIn("paymentStatus", ["paid", "authorized"])
      .whereNotIn("status", ["canceled", "cancelled", "expired"])
      .update({
        paymentStatus: "paid",
        monthlyBilling: true,
        monthlyBillingMonth: monthRange.yearMonth,
        monthlyClosedAt: closedAt,
        monthlyClosedBy: closedBy || "admin",
      });

    const orders = await db("orders")
      .where({ userId })
      .where("timestamp", ">=", monthRange.startIso)
      .where("timestamp", "<", monthRange.endIso)
      .orderBy("timestamp", "desc");

    res.json({
      success: true,
      userId,
      userName: user.name,
      month: monthRange.yearMonth,
      updatedCount,
      orders: orders.map((order) => ({
        ...order,
        items: parseJSON(order.items),
        total: parseFloat(order.total),
      })),
    });
  } catch (e) {
    console.error("❌ Erro ao fazer fechamento mensal:", e);
    res
      .status(e.statusCode || 500)
      .json({ error: e.message || "Erro ao fazer fechamento mensal" });
  }
});

// Atualizar pedido (adicionar paymentId após pagamento aprovado)
// Endpoint para marcar pedido como pago (presencial)
app.put("/api/orders/:id/mark-paid", async (req, res) => {
  const { id } = req.params;
  try {
    const order = await db("orders").where({ id }).first();
    if (!order) {
      return res.status(404).json({ error: "Pedido não encontrado" });
    }

    // Parse items from order
    let items = [];
    try {
      items =
        typeof order.items === "string" ? JSON.parse(order.items) : order.items;
    } catch (err) {
      console.error("❌ Erro ao parsear itens do pedido:", err);
      return res
        .status(500)
        .json({ error: "Erro ao processar itens do pedido" });
    }
    if (isTruthyDb(order.stockDeducted)) {
      console.log(`Pedido ${id} ja teve estoque descontado na criacao`);
      items = [];
    }

    const stockMovements = await adjustStockForOrderItems(db, items, -1);
    stockMovements.forEach((movement) => {
      console.log(
        `  ✅ [Manual] ${movement.name}: ${movement.stockBefore} → ${movement.stockAfter} (-${movement.quantity})`,
      );
    });

    await db("orders").where({ id }).update({
      paymentStatus: "paid",
      stockDeducted: true,
    });
    res.json({
      success: true,
      message: "Pedido marcado como pago e estoque atualizado",
    });
  } catch (e) {
    console.error("❌ Erro ao marcar pedido como pago:", e);
    res.status(500).json({ error: "Erro ao marcar pedido como pago" });
  }
});

app.put("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  let {
    paymentId,
    paymentStatus,
    separationChecklist,
    checklist,
    status,
    entregueCliente,
  } = req.body || {};
  // Importa serviço de pagamento para validação
  const { checkPaymentStatus } = await import("./services/paymentService.js");

  try {
    console.log(`📝 Atualizando pedido ${id} com payment ${paymentId}...`);

    // SINGLE-TENANT: Busca pedido apenas pelo id
    const order = await db("orders").where({ id }).first();

    if (!order) {
      return res.status(404).json({ error: "Pedido não encontrado" });
    }

    // Validação: paymentId deve ser string ou null
    if (paymentId !== undefined && paymentId !== null) {
      if (typeof paymentId !== "string") {
        paymentId = String(paymentId);
      }
      // Se vier objeto/array, zera
      if (
        typeof paymentId !== "string" ||
        paymentId === "[object Object]" ||
        Array.isArray(paymentId)
      ) {
        paymentId = null;
      }
    }

    const updates = {};
    if (paymentId !== undefined) updates.paymentId = paymentId;
    if (paymentStatus) updates.paymentStatus = paymentStatus;

    const checklistPayload =
      separationChecklist !== undefined ? separationChecklist : checklist;
    if (checklistPayload !== undefined) {
      const isValidChecklist =
        checklistPayload === null ||
        Array.isArray(checklistPayload) ||
        typeof checklistPayload === "object";

      if (!isValidChecklist) {
        return res.status(400).json({
          error: "separationChecklist deve ser um array, objeto ou null",
        });
      }

      updates.separationChecklist = JSON.stringify(checklistPayload || []);
      updates.separationChecklistUpdatedAt = new Date();
    }

    if (status !== undefined) {
      const normalizedStatus = String(status).trim();
      const allowedStatuses = new Set([
        "pending",
        "pending_payment",
        "active",
        "preparing",
        "ready",
        "delivered",
        "completed",
        "canceled",
        "cancelled",
        "expired",
      ]);

      if (!allowedStatuses.has(normalizedStatus)) {
        return res.status(400).json({ error: "Status de pedido invalido" });
      }

      updates.status = normalizedStatus;
      if (["delivered", "completed"].includes(normalizedStatus)) {
        updates.entregueCliente = true;
        if (!order.completedAt) updates.completedAt = new Date();
      }
    }

    if (entregueCliente !== undefined) {
      updates.entregueCliente = isTruthyDb(entregueCliente);
      if (updates.entregueCliente && !order.completedAt) {
        updates.completedAt = new Date();
      }
    }

    // 🎯 Validação real do pagamento antes de liberar pedido
    let isPaymentApproved = false;
    if (
      paymentId &&
      paymentStatus === "paid" &&
      order.status === "pending_payment"
    ) {
      try {
        // Consulta status real do pagamento
        const paymentResult = await checkPaymentStatus(paymentId, {
          mp_access_token: process.env.MP_ACCESS_TOKEN,
        });
        if (
          paymentResult &&
          (paymentResult.status === "approved" ||
            paymentResult.status === "authorized")
        ) {
          isPaymentApproved = true;
        }
      } catch (err) {
        console.error(
          "❌ Erro ao validar pagamento com Mercado Pago:",
          err.message,
        );
      }
      if (isPaymentApproved) {
        updates.status = "active";
        console.log(
          `🍳 Pedido ${id} liberado para COZINHA! (Pagamento REAL aprovado)`,
        );
      } else {
        console.warn(
          `⚠️ Pagamento não aprovado pelo Mercado Pago. Pedido NÃO liberado.`,
        );
        updates.status = "pending_payment";
      }
    }

    // Se pagamento foi aprovado, CONFIRMA a dedução do estoque
    if (
      isPaymentApproved &&
      order.paymentStatus === "pending" &&
      !isTruthyDb(order.stockDeducted)
    ) {
      console.log(`✅ Pagamento aprovado! Confirmando dedução do estoque...`);

      const items = parseJSON(order.items);

      const stockMovements = await adjustStockForOrderItems(db, items, -1);
      stockMovements.forEach((movement) => {
        console.log(
          `  ✅ ${movement.name}: ${movement.stockBefore} → ${movement.stockAfter} (-${movement.quantity})`,
        );
      });

      console.log(`🎉 Estoque confirmado e deduzido!`);
      updates.stockDeducted = true;
    } else if (isPaymentApproved && isTruthyDb(order.stockDeducted)) {
      updates.stockDeducted = true;
      console.log(`Pedido ${id} ja teve estoque descontado na criacao`);
    }

    await db("orders").where({ id }).update(updates);

    const updated = await db("orders").where({ id }).first();
    console.log(`✅ Pedido ${id} atualizado!`);

    res.json({
      ...normalizeOrderResponse(updated),
    });
  } catch (e) {
    console.error("❌ Erro ao atualizar pedido:", e);
    res.status(500).json({ error: "Erro ao atualizar pedido" });
  }
});

app.delete(
  "/api/orders/:id",
  authenticateToken,
  authorizeKitchen,
  async (req, res) => {
    try {
      console.log(`🗑️ DELETE pedido ${req.params.id}`);

      // Verifica se o pedido existe
      const order = await db("orders").where({ id: req.params.id }).first();
      console.log(`📦 Pedido existe?`, order ? `SIM` : "NÃO");

      if (!order) {
        console.log(`❌ Pedido não encontrado`);
        return res.status(404).json({ error: "Pedido não encontrado" });
      }

      console.log(`✅ Pedido encontrado:`, {
        id: order.id,
        status: order.status,
      });

      // Se estava pendente, libera a reserva de estoque
      if (order.paymentStatus === "pending") {
        console.log(
          `🔓 Liberando reserva de estoque do pedido ${req.params.id}...`,
        );

        const items = parseJSON(order.items);

        if (isTruthyDb(order.stockDeducted)) {
          const restoredItems = await adjustStockForOrderItems(db, items, 1);
          restoredItems.forEach((movement) => {
            console.log(
              `  ↩️ ${movement.name}: estoque ${movement.stockBefore} → ${movement.stockAfter} (+${movement.quantity})`,
            );
          });
        }

        for (const item of items) {
          const productId = getItemProductId(item);
          const product = await db("products").where({ id: productId }).first();

          if (product && product.stock_reserved > 0) {
            const newReserved = Math.max(
              0,
              product.stock_reserved - getItemQuantity(item, 0),
            );

            await db("products")
              .where({ id: productId })
              .update({ stock_reserved: newReserved });

            console.log(
              `  ↩️ ${item.name}: reserva ${product.stock_reserved} → ${newReserved}`,
            );
          }
        }

        console.log(`✅ Reserva liberada!`);
      }

      // Deleta o pedido do banco
      await db("orders").where({ id: req.params.id }).del();

      res.json({ ok: true });
    } catch (e) {
      console.error("❌ Erro ao finalizar pedido:", e);
      res.status(500).json({ error: "Erro ao finalizar" });
    }
  },
);

app.get("/api/user-orders", async (req, res) => {
  try {
    const { userId } = req.query;
    console.log(`📋 [GET /api/user-orders] userId: ${userId}`);

    let query = db("orders")
      .whereIn("paymentStatus", ["paid", "authorized"])
      .orderBy("timestamp", "desc");
    if (userId) {
      query = query.where({ userId });
    }
    const allOrders = await query.select("*");
    const enrichedOrders = await enrichOrdersWithDelivery(allOrders);
    console.log(
      `📋 [GET /api/user-orders] ${allOrders.length} pedidos encontrados`,
    );

    res.json(
      enrichedOrders.map((o) => normalizeOrderResponse(o)),
    );
  } catch (err) {
    console.error("❌ Erro em /api/user-orders:", err);
    res.status(500).json({ error: "Erro histórico" });
  }
});

// Excluir pedido do histórico (hard delete) + estornar estoque - apenas admin
app.delete(
  "/api/admin/orders/history/:id",
  authenticateToken,
  authorizeAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const restockedItems = [];

      await db.transaction(async (trx) => {
        const order = await trx("orders").where({ id }).first();
        if (!order) {
          const notFoundError = new Error("ORDER_NOT_FOUND");
          notFoundError.code = "ORDER_NOT_FOUND";
          throw notFoundError;
        }

        const normalizedPaymentStatus = String(
          order.paymentStatus || "",
        ).toLowerCase();
        const shouldRestoreStock = ["paid", "authorized", "approved"].includes(
          normalizedPaymentStatus,
        );

        const items = parseJSON(order.items);

        for (const item of Array.isArray(items) ? items : []) {
          const productId = getItemProductId(item);
          const quantity = getItemQuantity(item, 0);

          if (!productId || quantity <= 0) {
            continue;
          }

          const product = await trx("products").where({ id: productId }).first();
          if (!product) {
            continue;
          }

          const currentStock = Number(product.stock) || 0;
          const currentReserved = Number(product.stock_reserved) || 0;

          const nextStock = shouldRestoreStock
            ? currentStock + quantity
            : currentStock;
          const nextReserved = Math.max(0, currentReserved - quantity);

          await trx("products").where({ id: productId }).update({
            stock: nextStock,
            stock_reserved: nextReserved,
          });

          restockedItems.push({
            productId,
            name: item?.name || "Produto",
            quantity,
            stockBefore: currentStock,
            stockAfter: nextStock,
            reservedBefore: currentReserved,
            reservedAfter: nextReserved,
          });
        }

        await trx("order_products").where({ order_id: id }).del();
        await trx("orders").where({ id }).del();
      });

      return res.json({
        ok: true,
        message: "Pedido excluído do banco e estoque estornado com sucesso",
        orderId: id,
        restockedItems,
      });
    } catch (e) {
      if (e.code === "ORDER_NOT_FOUND") {
        return res.status(404).json({ error: "Pedido não encontrado" });
      }

      console.error("❌ [DELETE /api/admin/orders/history/:id] Erro:", e);
      return res.status(500).json({
        error: "Erro ao excluir pedido do histórico",
        message: e.message,
      });
    }
  },
);

// Endpoint para histórico de pedidos com filtros de data
app.get("/api/orders/history", async (req, res) => {
  try {
    console.log(
      "📋 [GET /api/orders/history] Buscando histórico de pedidos...",
    );
    const { start, end } = req.query;
    let query = db("orders")
      .where(function () {
        this.whereIn("paymentStatus", ["paid", "authorized"]).orWhere(
          function () {
            this.where("paymentType", "presencial");
          },
        );
      })
      .andWhere(function () {
        this.where("hiddenFromHistory", false).orWhereNull("hiddenFromHistory");
      })
      .orderBy("timestamp", "desc");
    if (start) query = query.where("timestamp", ">=", start);
    if (end) query = query.where("timestamp", "<=", end);
    const orders = await query;
    const enrichedOrders = await enrichOrdersWithDelivery(orders);
    console.log(
      `📋 [GET /api/orders/history] Encontrados ${orders.length} pedidos`,
    );
    const userIds = [
      ...new Set(enrichedOrders.map((order) => order.userId).filter(Boolean)),
    ];
    const usersById = new Map();
    if (userIds.length > 0) {
      const users = await db("users").whereIn("id", userIds);
      users.forEach((user) => usersById.set(user.id, user));
    }
    const currentMonth = toYearMonth();
    const parsedOrders = enrichedOrders.map((o) => ({
      ...normalizeOrderResponse(o),
      monthlyBilling: isTruthyDb(o.monthlyBilling),
      userMonthlyPayment: userHasMonthlyPayment(usersById.get(o.userId)),
      canMonthlyClose:
        userHasMonthlyPayment(usersById.get(o.userId)) &&
        toYearMonth(o.timestamp) === currentMonth &&
        !["paid", "authorized"].includes(o.paymentStatus) &&
        !["canceled", "cancelled", "expired"].includes(o.status),
      paymentMethod:
        o.paymentMethod ||
        o.payment_method ||
        o.payment_method_id ||
        o.paymentType ||
        "-",
    }));
    res.json(parsedOrders);
  } catch (e) {
    console.error("❌ [GET /api/orders/history] Erro:", e);
    res.status(500).json({
      error: "Erro ao buscar histórico de pedidos",
      message: e.message,
    });
  }
});

app.get("/api/orders/history/monthly-alerts", async (req, res) => {
  try {
    const monthRange = getMonthRange(req.query.month || getPreviousYearMonth());
    const monthlyUsers = await db("users").where({ monthlyPayment: true });
    const userIds = monthlyUsers.map((user) => user.id);

    if (userIds.length === 0) {
      return res.json({
        month: monthRange.yearMonth,
        alerts: [],
      });
    }

    const usersById = new Map(monthlyUsers.map((user) => [user.id, user]));
    const overdueOrders = await db("orders")
      .whereIn("userId", userIds)
      .where("timestamp", ">=", monthRange.startIso)
      .where("timestamp", "<", monthRange.endIso)
      .whereNotIn("paymentStatus", ["paid", "authorized"])
      .whereNotIn("status", ["canceled", "cancelled", "expired"])
      .orderBy("timestamp", "desc");

    const grouped = new Map();
    overdueOrders.forEach((order) => {
      const current = grouped.get(order.userId) || {
        userId: order.userId,
        userName: usersById.get(order.userId)?.name || order.userName || "Cliente",
        month: monthRange.yearMonth,
        orderCount: 0,
        total: 0,
        orderIds: [],
        message: "",
      };

      current.orderCount += 1;
      current.total += parseFloat(order.total) || 0;
      current.orderIds.push(order.id);
      grouped.set(order.userId, current);
    });

    const alerts = [...grouped.values()].map((alert) => ({
      ...alert,
      total: Number(alert.total.toFixed(2)),
      message: `${alert.userName} está devendo todos os pedidos do mês passado.`,
    }));

    res.json({
      month: monthRange.yearMonth,
      alerts,
    });
  } catch (e) {
    console.error("❌ Erro ao buscar alertas de pagamento mensal:", e);
    res.status(e.statusCode || 500).json({
      error: e.message || "Erro ao buscar alertas de pagamento mensal",
    });
  }
});

// Verificar se pedido existe (útil para debug)
app.get("/api/orders/:id", async (req, res) => {
  try {
    const order = await db("orders").where({ id: req.params.id }).first();
    if (!order) {
      return res.status(404).json({ error: "Pedido não encontrado" });
    }
    const [enriched] = await enrichOrdersWithDelivery([order]);
    res.json(normalizeOrderResponse(enriched));
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar pedido" });
  }
});

// --- IPN MERCADO PAGO (Para pagamentos físicos Point) ---

app.post("/api/notifications/mercadopago", async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔔 [${timestamp}] IPN RECEBIDO DO MERCADO PAGO (Point)`);
  console.log(`${"=".repeat(60)}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Query Params:", JSON.stringify(req.query, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log(`${"=".repeat(60)}\n`);

  try {
    // IPN pode vir via query params (?id=X&topic=Y) ou body webhook
    let id = req.query.id || req.body?.data?.id || req.body?.resource;
    let topic = req.query.topic || req.body?.type;

    console.log(`🔍 IPN extraído: ID=${id}, Topic=${topic}`);

    // Responde rápido ao MP (obrigatório - SEMPRE 200 OK)
    res.status(200).send("OK");

    // Processa notificação em background
    if (topic === "point_integration_ipn" && id) {
      console.log(`📨 Processando IPN do Point: ${id}`);

      // Single-tenant: utilize credenciais globais
      let intent = null;
      // Single-tenant: utilize apenas credenciais globais
      // Exemplo: buscar intent usando process.env.MP_ACCESS_TOKEN
      // ...existing code...

      // Se foi cancelado, já processa aqui
      if (intent.state === "CANCELED") {
        console.log(`❌ Payment Intent CANCELADO via IPN`);

        // Limpa a fila
        try {
          await paymentService.clearPaymentQueue({
            mp_access_token: MP_ACCESS_TOKEN,
            mp_device_id: MP_DEVICE_ID,
          });
          console.log(`🧹 Fila limpa após cancelamento via IPN`);
        } catch (e) {
          console.warn(`⚠️ Erro ao limpar fila: ${e.message}`);
        }

        // Cancela o pedido no banco
        if (orderId) {
          try {
            const order = await db("orders").where({ id: orderId }).first();
            if (order && order.paymentStatus === "pending") {
              // Libera estoque
              const items = parseJSON(order.items);
              if (isTruthyDb(order.stockDeducted)) {
              await adjustStockForOrderItems(db, items, 1);
              }
              for (const item of items) {
                const productId = getItemProductId(item);
                const product = await db("products")
                  .where({ id: productId })
                  .first();
                if (
                  product &&
                  product.stock_reserved > 0
                ) {
                  const newReserved = Math.max(
                    0,
                    product.stock_reserved - getItemQuantity(item, 0),
                  );
                  await db("products")
                    .where({ id: productId })
                    .update({ stock_reserved: newReserved });
                  console.log(
                    `  ↩️ Estoque liberado: ${item.name} (${product.stock_reserved} → ${newReserved})`,
                  );
                }
              }

              // Atualiza pedido
              await db("orders").where({ id: orderId }).update({
                paymentStatus: "canceled",
                status: "canceled",
                stockDeducted: false,
              });
              console.log(`✅ Pedido ${orderId} cancelado via IPN`);
            }
          } catch (dbError) {
            console.error(
              `❌ Erro ao cancelar pedido ${orderId}:`,
              dbError.message,
            );
          }
        }
        return;
      }

      // Se tem payment.id, busca o pagamento real
      if (intent.payment && intent.payment.id) {
        const paymentId = intent.payment.id;
        console.log(`💳 Buscando detalhes do pagamento real: ${paymentId}`);

        const paymentUrl = `https://api.mercadopago.com/v1/payments/${paymentId}`;
        const paymentResp = await fetch(paymentUrl, {
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
        });

        if (paymentResp.ok) {
          const payment = await paymentResp.json();
          console.log(`💳 Pagamento ${paymentId} | Status: ${payment.status}`);

          if (
            payment.status === "approved" ||
            payment.status === "authorized"
          ) {
            // Atualiza pedido no banco
            if (orderId) {
              try {
                const order = await db("orders").where({ id: orderId }).first();
                if (order && order.paymentStatus === "pending") {
                  await db("orders")
                    .where({ id: orderId })
                    .update({
                      paymentStatus: "paid",
                      status: "preparing",
                      paymentType: "online",
                      paymentMethod: payment.payment_method_id || "unknown",
                    });
                  console.log(
                    `✅ Pedido ${orderId} marcado como PAGO via IPN Card`,
                  );
                }
              } catch (dbError) {
                console.error(
                  `❌ Erro ao atualizar pedido ${orderId}:`,
                  dbError.message,
                );
              }
            }

            // Limpa a fila
            try {
              await paymentService.clearPaymentQueue({
                mp_access_token: MP_ACCESS_TOKEN,
                mp_device_id: MP_DEVICE_ID,
              });
              console.log(`🧹 Fila limpa após aprovação via IPN`);
            } catch (e) {
              console.warn(`⚠️ Erro ao limpar fila: ${e.message}`);
            }

            const amountInCents = Math.round(payment.transaction_amount * 100);
            const cacheKey = `amount_${amountInCents}`;

            await cachePayment(cacheKey, {
              paymentId: payment.id,
              amount: payment.transaction_amount,
              status: payment.status,
              timestamp: Date.now(),
            });

            console.log(
              `✅ Pagamento ${paymentId} confirmado via IPN! Valor: R$ ${payment.transaction_amount}`,
            );
            console.log(
              `ℹ️ External reference: ${
                payment.external_reference || "não informado"
              }`,
            );
          } else if (
            payment.status === "rejected" ||
            payment.status === "cancelled" ||
            payment.status === "refunded"
          ) {
            // Cancela o pedido no banco
            if (orderId) {
              try {
                const order = await db("orders").where({ id: orderId }).first();
                if (order && order.paymentStatus === "pending") {
                  // Libera estoque
                  const items = parseJSON(order.items);
                  if (isTruthyDb(order.stockDeducted)) {
                    await adjustStockForOrderItems(db, items, 1);
                  }
                  for (const item of items) {
                    const productId = getItemProductId(item);
                    const product = await db("products")
                      .where({ id: productId })
                      .first();
                    if (
                      product &&
                      product.stock_reserved > 0
                    ) {
                      const newReserved = Math.max(
                        0,
                        product.stock_reserved - getItemQuantity(item, 0),
                      );
                      await db("products")
                        .where({ id: productId })
                        .update({ stock_reserved: newReserved });
                      console.log(
                        `↩️ Estoque liberado: ${item.name} (${product.stock_reserved} → ${newReserved})`,
                      );
                    }
                  }

                  // Atualiza pedido
                  await db("orders").where({ id: orderId }).update({
                    paymentStatus: "canceled",
                    status: "canceled",
                    stockDeducted: false,
                  });
                  console.log(`✅ Pedido ${orderId} cancelado via IPN Card`);
                }
              } catch (dbError) {
                console.error(
                  `❌ Erro ao cancelar pedido ${orderId}:`,
                  dbError.message,
                );
              }
            }

            // Limpa a fila
            try {
              await paymentService.clearPaymentQueue({
                mp_access_token: MP_ACCESS_TOKEN,
                mp_device_id: MP_DEVICE_ID,
              });
              console.log(`🧹 Fila limpa após rejeição via IPN`);
            } catch (e) {
              console.warn(`⚠️ Erro ao limpar fila: ${e.message}`);
            }

            console.log(
              `❌ Pagamento ${paymentId} REJEITADO via IPN! Status: ${payment.status}`,
            );
            console.log(
              `ℹ️ External reference: ${
                payment.external_reference || "não informado"
              }`,
            );

            // Remove do cache se existir
            const amountInCents = Math.round(payment.transaction_amount * 100);
            const cacheKey = `amount_${amountInCents}`;
            await deleteCachedPayment(cacheKey);
            console.log(`🧹 Cache limpo para ${cacheKey}`);
          } else {
            console.log(
              `⏳ Pagamento ${paymentId} com status: ${payment.status} - aguardando`,
            );
          }
        }
      }
      return;
    }

    // Fallback: payment PIX
    if (topic === "payment" && id) {
      console.log(`📨 Processando IPN de pagamento PIX: ${id}`);

      // Single-tenant: utilize credenciais globais
      let payment = null;
      let storeUsed = null;
      // ...implemente aqui a lógica single-tenant se necessário...
      // Exemplo: buscar payment usando process.env.MP_ACCESS_TOKEN
      // ...existing code...

      if (payment.status === "approved") {
        console.log(`✅ Pagamento PIX ${id} APROVADO via IPN!`);

        // Atualiza pedido no banco
        const orderId = payment.external_reference;
        if (orderId) {
          try {
            const order = await db("orders").where({ id: orderId }).first();
            if (order && order.paymentStatus === "pending") {
              await db("orders").where({ id: orderId }).update({
                paymentStatus: "paid",
                status: "preparing",
              });
              console.log(`✅ Pedido ${orderId} marcado como PAGO via IPN PIX`);
            }
          } catch (dbError) {
            console.error(
              `❌ Erro ao atualizar pedido ${orderId}:`,
              dbError.message,
            );
          }
        }
      } else if (
        payment.status === "cancelled" ||
        payment.status === "rejected"
      ) {
        console.log(
          `❌ Pagamento PIX ${id} ${payment.status.toUpperCase()} via IPN`,
        );

        // Cancela pedido e libera estoque
        const orderId = payment.external_reference;
        if (orderId) {
          try {
            const order = await db("orders").where({ id: orderId }).first();
            if (order && order.paymentStatus === "pending") {
              // Libera estoque
              const items = parseJSON(order.items);
              if (isTruthyDb(order.stockDeducted)) {
                await adjustStockForOrderItems(db, items, 1);
              }
              for (const item of items) {
                const productId = getItemProductId(item);
                const product = await db("products")
                  .where({ id: productId })
                  .first();
                if (
                  product &&
                  product.stock_reserved > 0
                ) {
                  const newReserved = Math.max(
                    0,
                    product.stock_reserved - getItemQuantity(item, 0),
                  );
                  await db("products")
                    .where({ id: productId })
                    .update({ stock_reserved: newReserved });
                  console.log(
                    `↩️ Estoque liberado: ${item.name} (${product.stock_reserved} → ${newReserved})`,
                  );
                }
              }

              await db("orders").where({ id: orderId }).update({
                paymentStatus: "canceled",
                status: "canceled",
                stockDeducted: false,
              });
              console.log(`✅ Pedido ${orderId} cancelado via IPN PIX`);
            }
          } catch (dbError) {
            console.error(
              `❌ Erro ao cancelar pedido ${orderId}:`,
              dbError.message,
            );
          }
        }
      }
      return;
    }

    console.log(`⚠️ IPN ignorado - Topic: ${topic}, ID: ${id}`);
  } catch (error) {
    console.error("❌ Erro processando IPN:", error.message);
  }
});

// Endpoint teste para validar IPN
app.get("/api/notifications/mercadopago", (req, res) => {
  res.json({
    status: "ready",
    message: "IPN endpoint pronto",
  });
});

// --- WEBHOOK MERCADO PAGO (Notificação Instantânea) ---

app.post("/api/webhooks/mercadopago", async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔔 [${timestamp}] WEBHOOK RECEBIDO DO MERCADO PAGO`);
  console.log(`${"=".repeat(60)}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log(`${"=".repeat(60)}\n`);

  try {
    const { action, data, type } = req.body;

    // Responde rápido ao MP (obrigatório - SEMPRE 200 OK)
    res.status(200).json({ success: true, received: true });

    // Processa notificação em background
    if (action === "payment.created" || action === "payment.updated") {
      const paymentId = data?.id;

      if (!paymentId) {
        console.log("⚠️ Webhook sem payment ID");
        return;
      }

      console.log(`📨 Processando notificação de pagamento: ${paymentId}`);

      // Busca detalhes do pagamento
      const urlPayment = `https://api.mercadopago.com/v1/payments/${paymentId}`;
      const respPayment = await fetch(urlPayment, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const payment = await respPayment.json();

      console.log(
        `💳 Pagamento ${paymentId} | Status: ${payment.status} | Valor: R$ ${payment.transaction_amount}`,
      );

      // Processa status do pagamento
      if (payment.status === "approved" || payment.status === "authorized") {
        const amountInCents = Math.round(payment.transaction_amount * 100);
        const cacheKey = `amount_${amountInCents}`;

        await cachePayment(cacheKey, {
          paymentId: payment.id,
          amount: payment.transaction_amount,
          status: payment.status,
          timestamp: Date.now(),
        });

        console.log(
          `✅ Pagamento ${paymentId} confirmado via Webhook! Valor: R$ ${payment.transaction_amount}`,
        );

        // DESCONTA DO ESTOQUE usando external_reference (ID do pedido)
        const externalRef = payment.external_reference;
        if (externalRef) {
          console.log(
            `📦 Processando desconto de estoque para pedido: ${externalRef}`,
          );

          try {
            // Busca o pedido no banco
            const order = await db("orders").where({ id: externalRef }).first();

            if (order) {
              const items = parseJSON(order.items);
              console.log(`  🛒 ${items.length} item(ns) no pedido`);

              if (isTruthyDb(order.stockDeducted)) {
                console.log(
                  `  ✅ Pedido ${externalRef} ja teve estoque descontado na criacao`,
                );
              } else {
                const stockMovements = await adjustStockForOrderItems(
                  db,
                  items,
                  -1,
                );
                stockMovements.forEach((movement) => {
                  console.log(
                    `  ✅ ${movement.name}: ${movement.stockBefore} → ${movement.stockAfter} (${movement.quantity} vendido)`,
                  );
                });
              }

              // Atualiza o pedido para pago e ativo, salvando forma de pagamento
              await db("orders")
                .where({ id: externalRef })
                .update({
                  paymentStatus: "paid",
                  status: "active",
                  paymentType: "online",
                  paymentMethod: payment.payment_method_id || "unknown",
                  stockDeducted: true,
                });
              // Envia PDF por email para o cliente, se houver email
              if (order.email) {
                try {
                  await sendOrderPdfEmail({ order, email: order.email });
                  console.log(`📧 PDF enviado para ${order.email}`);
                } catch (e) {
                  console.error("Erro ao enviar PDF do pedido:", e);
                }
              }

              console.log(
                `🎉 Estoque atualizado com sucesso e pedido marcado como pago!`,
              );
            } else {
              console.log(`⚠️ Pedido ${externalRef} não encontrado no banco`);
            }
          } catch (err) {
            console.error(`❌ Erro ao descontar estoque: ${err.message}`);
          }
        }
      } else if (
        payment.status === "rejected" ||
        payment.status === "cancelled" ||
        payment.status === "refunded"
      ) {
        console.log(
          `❌ Pagamento ${paymentId} REJEITADO/CANCELADO via Webhook! Status: ${payment.status}`,
        );
        console.log(
          `ℹ️ External reference: ${
            payment.external_reference || "não informado"
          }`,
        );

        const externalRef = payment.external_reference;
        if (externalRef) {
          const order = await db("orders").where({ id: externalRef }).first();
          if (order && order.paymentStatus === "pending") {
            const items = parseJSON(order.items);
            if (isTruthyDb(order.stockDeducted)) {
              await adjustStockForOrderItems(db, items, 1);
            }
            await db("orders").where({ id: externalRef }).update({
              paymentStatus: "canceled",
              status: "canceled",
              stockDeducted: false,
            });
          }
        }

        // Remove do cache se existir
        const amountInCents = Math.round(payment.transaction_amount * 100);
        const cacheKey = `amount_${amountInCents}`;
        await deleteCachedPayment(cacheKey);
        console.log(`🧹 Cache limpo para ${cacheKey}`);
      } else {
        console.log(
          `⏳ Pagamento ${paymentId} com status: ${payment.status} - aguardando confirmação`,
        );
      }
    }
  } catch (error) {
    console.error("❌ Erro processando webhook:", error.message);
  }
});

// ============================================================================
// ⚠️ DEPRECATED: Endpoints de pagamento antigos (sem Multi-tenancy)
// ============================================================================
// ESTES ENDPOINTS FORAM REFATORADOS PARA:
// - services/paymentService.js (lógica de negócio)
// - controllers/paymentController.js (validação e controle)
// - routes/payment.js (rotas de pagamento)
//
// Agora usa apenas credenciais globais do Mercado Pago (mp_access_token, mp_device_id)
// Os endpoints estão em: /api/payment/*
//
// MANTER COMENTADO PARA REFERÊNCIA - REMOVER APÓS VALIDAÇÃO EM PRODUÇÃO
// ============================================================================

// --- INTEGRAÇÃO MERCADO PAGO POINT (Orders API Unificada) - COM MULTI-TENANCY ---

// CRIAR PAGAMENTO PIX (QR Code na tela)
app.post("/api/payment/create-pix", async (req, res) => {
  const { amount, description, orderId } = req.body;

  // Usa apenas credenciais globais (single-tenant)
  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const MP_DEVICE_ID = process.env.MP_DEVICE_ID;

  if (!MP_ACCESS_TOKEN) {
    console.error("Faltam credenciais do Mercado Pago");
    return res.json({ id: `mock_pix_${Date.now()}`, status: "pending" });
  }

  try {
    console.log(`💚 Criando pagamento PIX (QR Code) de R$ ${amount}...`);
    console.log(`📦 Payload: amount=${amount}, orderId=${orderId}`);

    const paymentPayload = {
      transaction_amount: parseFloat(amount),
      description: description || `Pedido ${orderId}`,
      payment_method_id: "pix",
      external_reference: orderId,
      notification_url:
        "https://backendkioskpro.onrender.com/api/notifications/mercadopago",
      payer: {
        email: "cliente@kiosk.com",
      },
    };

    console.log(
      `📤 Enviando para MP:`,
      JSON.stringify(paymentPayload, null, 2),
    );

    // Gera chave idempotente única para esta transação PIX
    const idempotencyKey = `pix_${orderId}_${Date.now()}`;

    const response = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(paymentPayload),
    });

    const data = await response.json();

    console.log(
      `📥 Resposta MP (status ${response.status}):`,
      JSON.stringify(data, null, 2),
    );

    if (!response.ok) {
      console.error("❌ Erro ao criar pagamento PIX:", data);
      return res.status(response.status).json({
        error: data.message || "Erro ao criar PIX",
        details: data,
      });
    }

    console.log(`✅ PIX criado! Payment ID: ${data.id}`);
    console.log(
      `📱 QR Code: ${data.point_of_interaction?.transaction_data?.qr_code}`,
    );

    const pixResponse = {
      id: data.id,
      status: data.status || "pending",
      qr_code: data.point_of_interaction?.transaction_data?.qr_code,
      qr_code_base64:
        data.point_of_interaction?.transaction_data?.qr_code_base64,
      ticket_url: data.point_of_interaction?.transaction_data?.ticket_url,
      type: "pix",
    };

    console.log(
      `📤 Enviando resposta ao frontend:`,
      JSON.stringify(pixResponse, null, 2),
    );
    res.json(pixResponse);
  } catch (error) {
    console.error("Erro ao criar PIX:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint legado para compatibilidade - redireciona para create-card
app.post("/api/payment/create", async (req, res) => {
  console.log(
    "⚠️ Endpoint legado /api/payment/create chamado - redirecionando para /create-card",
  );
  // Encaminha a requisição para o handler correto
  req.url = "/api/payment/create-card";
  return app._router.handle(req, res);
});

// ==========================================
// --- ROTAS EXCLUSIVAS PIX (QR Code na Tela) ---
// ==========================================

app.post("/api/pix/create", async (req, res) => {
  const { amount, description, email, payerName, orderId } = req.body;

  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: "Sem token MP" });

  try {
    console.log(`💠 Gerando PIX QR Code de R$ ${amount}...`);

    const idempotencyKey = `pix_${orderId || Date.now()}_${Date.now()}`;

    const response = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        transaction_amount: parseFloat(amount),
        description: description || "Pedido Kiosk",
        payment_method_id: "pix",
        payer: {
          email: email || "cliente@kiosk.com",
          first_name: payerName || "Cliente",
        },
        external_reference: orderId,
        notification_url:
          "https://backendkioskpro.onrender.com/api/notifications/mercadopago",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Erro ao gerar PIX:", data);
      throw new Error(data.message || "Erro ao gerar PIX");
    }

    const qrCodeBase64 =
      data.point_of_interaction?.transaction_data?.qr_code_base64;
    const qrCodeCopyPaste =
      data.point_of_interaction?.transaction_data?.qr_code;
    const paymentId = data.id;

    console.log(`✅ PIX gerado! Payment ID: ${paymentId}`);

    res.json({
      paymentId,
      qrCodeBase64,
      qrCodeCopyPaste,
      status: "pending",
      type: "pix",
    });
  } catch (error) {
    console.error("❌ Erro ao criar PIX:", error);
    res.status(500).json({ error: error.message || "Falha ao gerar PIX" });
  }
});

app.get("/api/pix/status/:id", async (req, res) => {
  const { id } = req.params;

  if (!MP_ACCESS_TOKEN) return res.status(500).json({ error: "Sem token" });

  try {
    console.log(`💠 Verificando status PIX: ${id}`);

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${id}`,
      {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      },
    );

    const data = await response.json();

    console.log(`💠 Status PIX (${id}): ${data.status}`);

    if (data.status === "approved") {
      return res.json({ status: "approved", paymentId: id });
    }

    res.json({ status: data.status || "pending" });
  } catch (error) {
    console.error("❌ Erro ao verificar PIX:", error);
    res.json({ status: "pending" });
  }
});

// ==========================================

// CRIAR PAGAMENTO NA MAQUININHA (Point Integration API - volta ao original)
app.post("/api/payment/create-card", async (req, res) => {
  const { amount, description, orderId, paymentMethod } = req.body;
  // Usa apenas credenciais globais (single-tenant)
  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const MP_DEVICE_ID = process.env.MP_DEVICE_ID;

  // ✅ DETECÇÃO AUTOMÁTICA: Se for PIX, gera QR Code (Payments API) - NÃO DEVERIA CHEGAR AQUI
  if (paymentMethod === "pix") {
    console.log(
      `🔀 PIX detectado - redirecionando para /api/payment/create-pix`,
    );
    return res.status(400).json({
      error: "Use o endpoint /api/payment/create-pix para pagamentos PIX.",
    });
  }

  // ✅ CARTÕES: Segue para maquininha
  if (!MP_ACCESS_TOKEN || !MP_DEVICE_ID) {
    console.error("Faltam credenciais do Mercado Pago");
    return res.json({ id: `mock_pay_${Date.now()}`, status: "pending" });
  }

  try {
    console.log(`💳 Criando payment intent na Point ${MP_DEVICE_ID}...`);
    console.log(`💰 Método solicitado: ${paymentMethod || "todos"}`);

    // Payload simplificado para Point Integration API
    const payload = {
      amount: Math.round(parseFloat(amount) * 100), // Centavos
      description: description || `Pedido ${orderId}`,
      additional_info: {
        external_reference: orderId,
        print_on_terminal: true,
      },
    };

    // Se método especificado (crédito/débito), adiciona filtro
    if (paymentMethod) {
      const paymentTypeMap = {
        debit: "debit_card",
        credit: "credit_card",
      };

      const type = paymentTypeMap[paymentMethod];

      if (type) {
        payload.payment = {
          type: type,
          installments: paymentMethod === "credit" ? 1 : undefined,
          installments_cost: paymentMethod === "credit" ? "buyer" : undefined,
        };
        console.log(`🎯 Filtro ativo: ${type}`);
      }
    }

    console.log(
      `📤 Payload Point Integration:`,
      JSON.stringify(payload, null, 2),
    );

    const url = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID}/payment-intents`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "❌ Erro ao criar payment intent:",
        JSON.stringify(data, null, 2),
      );
      console.error(`📡 Status HTTP: ${response.status}`);
      throw new Error(data.message || JSON.stringify(data.errors || data));
    }

    console.log(`✅ Payment intent criado! ID: ${data.id}`);
    console.log(`📱 Status: ${data.state}`);

    res.json({
      id: data.id,
      status: "open",
      type: "point",
    });
  } catch (error) {
    console.error("❌ Erro Pagamento Point:", error);
    console.error("❌ Stack trace:", error.stack);
    res
      .status(500)
      .json({ error: error.message || "Falha ao comunicar com maquininha" });
  }
});

// Verificar status PAGAMENTO (híbrido: Order PIX ou Payment Intent Point)
app.get("/api/payment/status/:paymentId", async (req, res) => {
  const { paymentId } = req.params;

  if (paymentId.startsWith("mock_")) return res.json({ status: "approved" });

  try {
    console.log(`🔍 [STATUS] Verificando pagamento: ${paymentId}`);

    // Usa apenas credenciais globais (single-tenant)
    const storeConfig = {
      mp_access_token: MP_ACCESS_TOKEN,
      mp_device_id: MP_DEVICE_ID,
    };

    if (!storeConfig.mp_access_token) {
      return res.status(500).json({ error: "Credenciais MP não configuradas" });
    }

    // 1. Tenta buscar como Payment Intent (Point Integration API)

    const intentUrl = `https://api.mercadopago.com/point/integration-api/payment-intents/${paymentId}`;
    const intentResponse = await fetch(intentUrl, {
      headers: { Authorization: `Bearer ${storeConfig.mp_access_token}` },
    });

    if (intentResponse.ok) {
      // É um Payment Intent (maquininha)
      const intent = await intentResponse.json();
      console.log(`💳 Payment Intent ${paymentId} | State: ${intent.state}`);

      // Verifica se tem payment.id (pagamento aprovado)
      if (intent.payment && intent.payment.id) {
        const realPaymentId = intent.payment.id;
        console.log(`✅ Payment Intent APROVADO! Payment ID: ${realPaymentId}`);

        // Busca detalhes do pagamento real para confirmar status
        try {
          const paymentDetailsUrl = `https://api.mercadopago.com/v1/payments/${realPaymentId}`;
          const paymentDetailsResp = await fetch(paymentDetailsUrl, {
            headers: { Authorization: `Bearer ${storeConfig.mp_access_token}` },
          });

          if (paymentDetailsResp.ok) {
            const paymentDetails = await paymentDetailsResp.json();
            console.log(`💳 Pagamento real status: ${paymentDetails.status}`);

            if (
              paymentDetails.status === "approved" ||
              paymentDetails.status === "authorized"
            ) {
              console.log(`✅ PAGAMENTO CONFIRMADO COMO APROVADO!`);

              // 🧹 Limpa a fila após aprovação
              try {
                console.log(`🧹 Limpando fila após aprovação...`);
                await paymentService.clearPaymentQueue({
                  mp_access_token: MP_ACCESS_TOKEN,
                  mp_device_id: MP_DEVICE_ID,
                });
              } catch (queueError) {
                console.warn(`⚠️ Erro ao limpar fila: ${queueError.message}`);
              }

              return res.json({
                status: "approved",
                paymentId: realPaymentId,
                paymentStatus: paymentDetails.status,
              });
            }

            // Verifica se foi rejeitado/cancelado
            if (
              paymentDetails.status === "rejected" ||
              paymentDetails.status === "cancelled" ||
              paymentDetails.status === "refunded"
            ) {
              console.log(
                `❌ PAGAMENTO REJEITADO/CANCELADO: ${paymentDetails.status}`,
              );

              // 🧹 Limpa a fila após rejeição
              try {
                console.log(`🧹 Limpando fila após rejeição...`);
                await paymentService.clearPaymentQueue({
                  mp_access_token: MP_ACCESS_TOKEN,
                  mp_device_id: MP_DEVICE_ID,
                });
              } catch (queueError) {
                console.warn(`⚠️ Erro ao limpar fila: ${queueError.message}`);
              }

              // Busca external_reference para liberar pedido
              const orderId = intent.additional_info?.external_reference;

              return res.json({
                status: "rejected",
                paymentId: realPaymentId,
                paymentStatus: paymentDetails.status,
                reason: "rejected_by_terminal",
                orderId: orderId || null,
              });
            }

            // Outros status (pending, in_process, etc)
            console.log(`⏳ PAGAMENTO PENDENTE: ${paymentDetails.status}`);
            return res.json({
              status: "pending",
              paymentId: realPaymentId,
              paymentStatus: paymentDetails.status,
            });
          }
        } catch (e) {
          console.log(`⚠️ Erro ao buscar detalhes do pagamento: ${e.message}`);
        }

        // Fallback: se não conseguiu buscar detalhes, retorna pending (não approved!)
        console.log(
          `⚠️ Fallback: não foi possível confirmar status do pagamento ${realPaymentId}`,
        );
        return res.json({ status: "pending", paymentId: realPaymentId });
      }

      // Estados finalizados - NÃO assume approved automaticamente!
      // FINISHED pode ser rejected, cancelled, refunded, etc
      if (intent.state === "FINISHED") {
        console.log(
          `⚠️ Intent FINISHED mas sem payment.id - precisa verificar manualmente`,
        );

        // Tenta buscar pelo external_reference se houver
        if (intent.additional_info?.external_reference) {
          const orderId = intent.additional_info.external_reference;
          console.log(
            `🔍 Tentando buscar pagamento por external_reference: ${orderId}`,
          );

          try {
            const searchUrl = `https://api.mercadopago.com/v1/payments/search?external_reference=${orderId}`;
            const searchResp = await fetch(searchUrl, {
              headers: {
                Authorization: `Bearer ${storeConfig.mp_access_token}`,
              },
            });

            if (searchResp.ok) {
              const searchData = await searchResp.json();
              if (searchData.results && searchData.results.length > 0) {
                const payment = searchData.results[0];
                console.log(
                  `💳 Pagamento encontrado via search: ${payment.id} | Status: ${payment.status}`,
                );

                if (
                  payment.status === "approved" ||
                  payment.status === "authorized"
                ) {
                  return res.json({
                    status: "approved",
                    paymentId: payment.id,
                  });
                } else if (
                  payment.status === "rejected" ||
                  payment.status === "cancelled" ||
                  payment.status === "refunded"
                ) {
                  return res.json({
                    status: "rejected",
                    paymentId: payment.id,
                  });
                } else {
                  return res.json({ status: "pending", paymentId: payment.id });
                }
              }
            }
          } catch (searchError) {
            console.log(
              `⚠️ Erro ao buscar por external_reference: ${searchError.message}`,
            );
          }
        }

        // Se não encontrou nada, retorna pending (não approved!)
        console.log(
          `⚠️ Intent FINISHED mas status do pagamento desconhecido - retornando pending`,
        );
        return res.json({ status: "pending", paymentId: paymentId });
      }

      if (intent.state === "CANCELED" || intent.state === "ERROR") {
        const isCanceled = intent.state === "CANCELED";
        const isError = intent.state === "ERROR";

        console.log(
          `❌ Intent ${intent.state}${
            isCanceled
              ? " (cancelado pelo usuário na maquininha)"
              : " (erro no processamento)"
          }`,
        );

        // 🧹 Limpa a fila após cancelamento/erro
        try {
          console.log(`🧹 Limpando fila após ${intent.state}...`);
          await paymentService.clearPaymentQueue({
            mp_access_token: MP_ACCESS_TOKEN,
            mp_device_id: MP_DEVICE_ID,
          });
        } catch (queueError) {
          console.warn(`⚠️ Erro ao limpar fila: ${queueError.message}`);
        }

        // --- LÓGICA DE CANCELAMENTO DO PEDIDO NO BANCO ---
        const orderId = intent.additional_info?.external_reference;
        if (orderId) {
          console.log(`  -> Pedido associado: ${orderId}. Cancelando...`);
          try {
            const order = await db("orders").where({ id: orderId }).first();

            // Apenas cancela se o pedido ainda estiver pendente
            if (order && order.paymentStatus === "pending") {
              // 1. Libera o estoque reservado
              const items = parseJSON(order.items);
              for (const item of items) {
                const productId = getItemProductId(item);
                const product = await db("products")
                  .where({ id: productId })
                  .first();
                if (
                  product &&
                  product.stock_reserved > 0
                ) {
                  const newReserved = Math.max(
                    0,
                    product.stock_reserved - getItemQuantity(item, 0),
                  );
                  await db("products")
                    .where({ id: productId })
                    .update({ stock_reserved: newReserved });
                  console.log(
                    `    ↩️ Estoque liberado para ${item.name}: ${product.stock_reserved} → ${newReserved}`,
                  );
                }
              }

              // 2. Atualiza o status do pedido para 'canceled'
              await db("orders")
                .where({ id: orderId })
                .update({ paymentStatus: "canceled", status: "canceled" });

              console.log(
                `  ✅ Pedido ${orderId} e estoque atualizados com sucesso!`,
              );
            } else {
              console.log(
                `  ⚠️ Pedido ${orderId} não está mais pendente ou não foi encontrado. Nenhuma ação necessária.`,
              );
            }
          } catch (dbError) {
            console.error(
              `  ❌ Erro ao cancelar o pedido ${orderId} no banco:`,
              dbError.message,
            );
          }
        }
        // --- FIM DA LÓGICA ---

        return res.json({
          status: "canceled",
          reason: isCanceled ? "canceled_by_user" : "payment_error",
          orderId: orderId || null,
          message: isCanceled
            ? "Pagamento cancelado na maquininha pelo usuário"
            : "Erro ao processar pagamento na maquininha",
        });
      }

      // Ainda pendente
      console.log(`⏳ Intent pendente (${intent.state})`);
      return res.json({ status: "pending" });
    }

    // 2. Se não é Payment Intent, tenta como Payment PIX
    console.log(`🔄 Não é Payment Intent, tentando como Payment PIX...`);

    const paymentUrl = `https://api.mercadopago.com/v1/payments/${paymentId}`;
    const paymentResponse = await fetch(paymentUrl, {
      headers: { Authorization: `Bearer ${storeConfig.mp_access_token}` },
    });

    if (paymentResponse.ok) {
      const payment = await paymentResponse.json();
      console.log(`💚 Payment ${paymentId} | Status: ${payment.status}`);

      if (payment.status === "approved") {
        console.log(`✅ Payment PIX APROVADO!`);
        return res.json({ status: "approved", paymentId: payment.id });
      } else if (
        payment.status === "cancelled" ||
        payment.status === "rejected"
      ) {
        console.log(`❌ Payment ${payment.status.toUpperCase()}`);
        return res.json({
          status: "canceled",
          reason: "canceled_by_system",
          paymentStatus: payment.status,
          message:
            payment.status === "cancelled"
              ? "Pagamento PIX cancelado"
              : "Pagamento PIX rejeitado",
        });
      }

      console.log(`⏳ Payment ainda pendente (${payment.status})`);
      return res.json({ status: "pending" });
    }

    // 3. Não encontrado em nenhum lugar
    console.log(`⚠️ Pagamento ${paymentId} não encontrado`);
    res.json({ status: "pending" });
  } catch (error) {
    console.error("❌ Erro ao verificar status:", error.message);
    res.json({ status: "pending" });
  }
});

// ENDPOINT LEGADO (para compatibilidade temporária com antigo sistema)
app.get("/api/payment/status-pix/:orderId", async (req, res) => {
  console.log(
    `⚠️ Endpoint legado /status-pix chamado - redirecionando para /status`,
  );
  return res.redirect(307, `/api/payment/status/${req.params.orderId}`);
});

// ==========================================
// --- CANCELAMENTO E LIMPEZA ---
// ==========================================

// Cancelar pagamento específico (Point Intent ou PIX Payment)
app.delete("/api/payment/cancel/:paymentId", async (req, res) => {
  const { paymentId } = req.params;
  // Usa apenas credenciais globais (single-tenant)
  const MP_ACCESS_TOKEN_LOCAL = MP_ACCESS_TOKEN;
  const MP_DEVICE_ID_LOCAL = MP_DEVICE_ID;

  if (!MP_ACCESS_TOKEN_LOCAL) {
    return res.json({ success: true, message: "Mock cancelado" });
  }

  try {
    console.log(`🛑 Tentando cancelar pagamento: ${paymentId}`);

    // 1. Tenta cancelar como um Payment Intent da maquininha (Point)
    if (MP_DEVICE_ID_LOCAL) {
      const urlIntent = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID_LOCAL}/payment-intents/${paymentId}`;

      console.log(`  -> Enviando DELETE para a maquininha: ${urlIntent}`);
      const intentResponse = await fetch(urlIntent, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN_LOCAL}` },
      });

      // Se a requisição foi bem-sucedida (200, 204) ou se o recurso não foi encontrado (404, já foi cancelado), consideramos sucesso.
      if (intentResponse.ok || intentResponse.status === 404) {
        console.log(
          `✅ Comando de cancelamento para a maquininha enviado com sucesso para ${paymentId}.`,
        );
        return res.json({
          success: true,
          message: "Pagamento na maquininha cancelado.",
        });
      }
      // Se a API retornar 409, significa que o pagamento está sendo processado e não pode ser cancelado.
      if (intentResponse.status === 409) {
        console.log(
          `⚠️ Não foi possível cancelar ${paymentId} na maquininha: já está sendo processado.`,
        );
        return res.status(409).json({
          success: false,
          message: "Pagamento em processamento, não pode ser cancelado.",
        });
      }
    }

    // 2. Se não for um pagamento de maquininha ou se falhou, tenta cancelar como um pagamento PIX.
    console.log(`  -> Tentando cancelar como Payment PIX...`);
    const urlPayment = `https://api.mercadopago.com/v1/payments/${paymentId}`;
    const response = await fetch(urlPayment, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN_LOCAL}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "cancelled" }),
    });

    if (response.ok) {
      console.log(`✅ Payment PIX ${paymentId} cancelado`);
      return res.json({ success: true, message: "PIX cancelado" });
    }

    // Se chegou aqui, não conseguiu cancelar
    console.log(`⚠️ Não foi possível cancelar ${paymentId} como PIX ou Point.`);
    return res.json({
      success: false,
      message: "Não foi possível cancelar - pode já estar finalizado",
    });
  } catch (error) {
    console.error("❌ Erro ao cancelar pagamento:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Limpar TODA a fila da maquininha (útil para logout/sair)
app.post("/api/payment/clear-all", async (req, res) => {
  // Usa apenas credenciais globais (single-tenant)
  const MP_ACCESS_TOKEN_LOCAL = MP_ACCESS_TOKEN;
  const MP_DEVICE_ID_LOCAL = MP_DEVICE_ID;

  if (!MP_ACCESS_TOKEN_LOCAL || !MP_DEVICE_ID_LOCAL) {
    return res.json({ success: true, cleared: 0 });
  }

  try {
    console.log(`🧹 [CLEAR ALL] Limpando TODA a fila da maquininha...`);

    const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID_LOCAL}/payment-intents`;
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN_LOCAL}` },
    });

    if (!listResp.ok) {
      return res.json({ success: false, error: "Erro ao listar intents" });
    }

    const listData = await listResp.json();
    const events = listData.events || [];

    console.log(`🔍 Encontradas ${events.length} intent(s) na fila`);

    let cleared = 0;

    for (const ev of events) {
      const iId = ev.payment_intent_id || ev.id;

      try {
        const delResp = await fetch(`${listUrl}/${iId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN_LOCAL}` },
        });

        if (delResp.ok || delResp.status === 404) {
          console.log(`  ✅ Intent ${iId} removida`);
          cleared++;
        }
      } catch (e) {
        console.log(`  ⚠️ Erro ao remover ${iId}: ${e.message}`);
      }

      // Pequeno delay entre remoções
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log(
      `✅ [CLEAR ALL] ${cleared} intent(s) removida(s) - Maquininha limpa!`,
    );

    res.json({
      success: true,
      cleared: cleared,
      message: `${cleared} pagamento(s) removido(s) da fila`,
    });
  } catch (error) {
    console.error("❌ Erro ao limpar fila:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Configurar Point Smart 2 (modo operacional e vinculação)
// app.post("/api/point/configure", async (req, res) => {
//   // Usa apenas credenciais globais (single-tenant)
//   const MP_ACCESS_TOKEN_LOCAL = MP_ACCESS_TOKEN;
//   const MP_DEVICE_ID_LOCAL = MP_DEVICE_ID;

//   if (!MP_ACCESS_TOKEN_LOCAL || !MP_DEVICE_ID_LOCAL) {
//     return res.json({ success: false, error: "Credenciais não configuradas" });
//   }

//   try {
//     console.log(`⚙️ Configurando Point  2: ${MP_DEVICE_ID_LOCAL}`);

//     // Configuração do dispositivo Point Smart
//     const configUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID_LOCAL}`;

//     const configPayload = {
//       operating_mode: "PDV", // Modo PDV - integração com frente de caixa
//       // Isso mantém a Point vinculada e bloqueia acesso ao menu
//     };

//     const response = await fetch(configUrl, {
//       method: "PATCH",
//       headers: {
//         Authorization: `Bearer ${MP_ACCESS_TOKEN_LOCAL}`,
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify(configPayload),
//     });

//     if (response.ok) {
//       const data = await response.json();
//       console.log(`✅ Point Smart 2 configurada em modo PDV`);
//       console.log(`🔒 Menu bloqueado - apenas pagamentos via API`);

//       return res.json({
//         success: true,
//         message: "Point configurada com sucesso",
//         mode: "PDV",
//         device: data,
//       });
//     } else {
//       const error = await response.json();
//       console.error(`❌ Erro ao configurar Point:`, error);
//       return res.status(400).json({ success: false, error: error.message });
//     }
//   } catch (error) {
//     console.error("❌ Erro ao configurar Point Smart 2:", error.message);
//     res.status(500).json({ success: false, error: error.message });
//   }
// });

// // Verificar status da Point Smart 2
// app.get("/api/point/status", async (req, res) => {
//   // Usa apenas credenciais globais (single-tenant)
//   const MP_ACCESS_TOKEN_LOCAL = MP_ACCESS_TOKEN;
//   const MP_DEVICE_ID_LOCAL = MP_DEVICE_ID;

//   if (!MP_ACCESS_TOKEN_LOCAL || !MP_DEVICE_ID_LOCAL) {
//     console.error("⚠️ Status Point: Credenciais não configuradas");
//     console.error(
//       `MP_ACCESS_TOKEN: ${MP_ACCESS_TOKEN_LOCAL ? "OK" : "AUSENTE"}`,
//     );
//     console.error(`MP_DEVICE_ID: ${MP_DEVICE_ID_LOCAL || "AUSENTE"}`);
//     return res.json({
//       connected: false,
//       error: "Credenciais não configuradas",
//     });
//   }

//   try {
//     console.log(`🔍 Verificando status da Point: ${MP_DEVICE_ID_LOCAL}`);

//     const deviceUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID_LOCAL}`;
//     const response = await fetch(deviceUrl, {
//       headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN_LOCAL}` },
//     });

//     console.log(`📡 Resposta API Point: Status ${response.status}`);

//     if (response.ok) {
//       const device = await response.json();
//       console.log(`✅ Point encontrada:`, device);

//       return res.json({
//         connected: true,
//         id: device.id,
//         operating_mode: device.operating_mode,
//         status: device.status,
//         model: device.model || "Point Smart 2",
//       });
//     } else {
//       const errorData = await response.json();
//       console.error(`❌ Erro ao buscar Point:`, errorData);
//       return res.json({
//         connected: false,
//         error: "Point não encontrada",
//         details: errorData,
//       });
//     }
//   } catch (error) {
//     console.error("❌ Exceção ao verificar Point:", error);
//     res.status(500).json({ connected: false, error: error.message });
//   }
// });

// Limpar TODA a fila de pagamentos da maquininha (chamar após pagamento aprovado)
// app.post("/api/payment/clear-queue", async (req, res) => {
//   // Usa apenas credenciais globais (single-tenant)
//   const MP_ACCESS_TOKEN_LOCAL = MP_ACCESS_TOKEN;
//   const MP_DEVICE_ID_LOCAL = MP_DEVICE_ID;

//   if (!MP_ACCESS_TOKEN_LOCAL || !MP_DEVICE_ID_LOCAL) {
//     return res.json({ success: true, cleared: 0 });
//   }

//   try {
//     console.log(`🧹 [CLEAR QUEUE] Limpando TODA a fila da Point Pro 2...`);

//     const listUrl = `https://api.mercadopago.com/point/integration-api/devices/${MP_DEVICE_ID_LOCAL}/payment-intents`;
//     const listResp = await fetch(listUrl, {
//       headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN_LOCAL}` },
//     });

//     if (!listResp.ok) {
//       return res.json({ success: false, error: "Erro ao listar intents" });
//     }

//     const listData = await listResp.json();
//     const events = listData.events || [];

//     console.log(`🔍 Encontradas ${events.length} intent(s) na fila`);

//     let cleared = 0;

//     for (const ev of events) {
//       const iId = ev.payment_intent_id || ev.id;
//       const state = ev.state;

//       try {
//         const delResp = await fetch(`${listUrl}/${iId}`, {
//           method: "DELETE",
//           headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN_LOCAL}` },
//         });

//         if (delResp.ok || delResp.status === 404) {
//           console.log(`  ✅ Intent ${iId} (${state}) removida`);
//           cleared++;
//         }
//       } catch (e) {
//         console.log(`  ⚠️ Erro ao remover ${iId}: ${e.message}`);
//       }

//       // Pequeno delay entre remoções
//       await new Promise((r) => setTimeout(r, 200));
//     }

//     console.log(
//       `✅ [CLEAR QUEUE] ${cleared} intent(s) removida(s) - Point Pro 2 completamente limpa!`,
//     );

//     res.json({
//       success: true,
//       cleared: cleared,
//       message: `${cleared} pagamento(s) removido(s) da fila`,
//     });
//   } catch (error) {
//     console.error("❌ Erro ao limpar fila:", error.message);
//     res.status(500).json({ success: false, error: error.message });
//   }
// });

// ============================================================================
// FIM DA SEÇÃO DEPRECATED
// ============================================================================

// --- Rotas de IA ---

// --- Rota 1: Sugestão de IA ---
app.post("/api/ai/suggestion", async (req, res) => {
  if (!openai) {
    return res.json({ text: "IA indisponível" });
  }

  try {
    // Busca todos os produtos disponíveis
    const products = await db("products").select(
      "id",
      "name",
      "price",
      "category",
      "stock",
    );

    const productList = products
      .map(
        (p) =>
          `- ${p.name} (${p.category}) - R$ ${p.price}${
            Number(p.stock) <= 0 ? " - sob encomenda" : ""
          } ${
            p.description ? "- " + p.description : ""
          }`,
      )
      .join("\n");

    const systemPrompt = `Você é um vendedor especializado em pelúcias e brinquedos PrimePlush.
🎯 SUA MISSÃO: Recomendar produtos DO NOSSO CATÁLOGO REAL para o cliente.
📋 PRODUTOS QUE TEMOS DISPONÍVEIS AGORA:
${productList}
... (regras ocultas para brevidade) ...`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: req.body.prompt },
      ],
      max_tokens: 150,
    });

    const aiResponse = completion.choices[0].message.content;
    return res.json({ text: aiResponse });
  } catch (e) {
    console.error("[ERRO AI]:", e);
    return res.json({ text: "Sugestão indisponível no momento." });
  }
});

// --- Rota 2: SuperAdmin (Marca recebíveis) ---
app.post(
  "/api/super-admin/receivables/mark-received-by-ids",
  async (req, res) => {
    console.log(
      "[LOG] POST /api/super-admin/receivables/mark-received-by-ids chamado",
    );

    try {
      const superAdminPassword = req.headers["x-super-admin-password"];

      if (!SUPER_ADMIN_PASSWORD) {
        return res.status(503).json({ error: "Super Admin não configurado." });
      }

      if (superAdminPassword !== SUPER_ADMIN_PASSWORD) {
        return res
          .status(401)
          .json({ error: "Acesso negado. Senha inválida." });
      }

      let { orderIds } = req.body;
      if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
        return res.status(400).json({ error: "orderIds obrigatório (array)" });
      }

      const now = new Date().toISOString();
      const updateResult = await db("orders").whereIn("id", orderIds).update({
        repassadoSuperAdmin: 1,
        dataRepasseSuperAdmin: now,
      });

      // Calcula o valor total a receber desses pedidos
      const orders = await db("orders").whereIn("id", orderIds);
      let totalBrutoReceber = 0;
      let valorRecebidoDetalhado = [];
      for (const order of orders) {
        let items = [];
        try {
          items = Array.isArray(order.items)
            ? order.items
            : JSON.parse(order.items);
        } catch {
          items = [];
        }
        let valorRecebidoPedido = 0;
        for (const item of items) {
          let precoBruto = 0;
          let precoVenda = 0;
          const prodId = item.productId || item.id;
          if (prodId) {
            const prod = await db("products").where({ id: prodId }).first();
            precoBruto = prod && prod.priceRaw ? parseFloat(prod.priceRaw) : 0;
            precoVenda = prod && prod.price ? parseFloat(prod.price) : 0;
          } else {
            if (item.precoBruto !== undefined) {
              precoBruto = parseFloat(item.precoBruto);
            }
            if (item.price !== undefined) {
              precoVenda = parseFloat(item.price);
            }
          }
          const quantity = getItemQuantity(item);
          const valueToReceive = (precoVenda - precoBruto) * quantity;
          valorRecebidoPedido += valueToReceive;
          totalBrutoReceber += valueToReceive;
        }
        valorRecebidoDetalhado.push({
          orderId: order.id,
          valorRecebido: valorRecebidoPedido,
        });
      }

      // Insere registro na tabela de recebíveis
      await db("super_admin_receivables").insert({
        amount: totalBrutoReceber,
        order_ids: JSON.stringify(orderIds),
        received_at: now,
      });

      console.log(
        "[DEBUG] Resultado do Update:",
        updateResult,
        "Total Recebido:",
        totalBrutoReceber,
      );

      return res.json({
        success: true,
        message: "Recebíveis marcados como recebidos",
        receivedOrderIds: orderIds,
        dataRepasse: now,
        updateResult,
        totalRecebido: totalBrutoReceber,
        valorRecebidoDetalhado,
      });
    } catch (err) {
      console.error("[LOG] Erro interno:", err);
      return res.status(500).json({
        error: "Erro interno",
        details: err.message,
      });
    }
  },
);

app.post("/api/ai/chat", async (req, res) => {
  if (!openai) {
    console.log(
      "❌ OpenAI não inicializada - OPENAI_API_KEY está configurada?",
    );
    return res.status(503).json({ error: "IA indisponível" });
  }
  try {
    // Busca produtos globais para contexto
    const products = await db("products")
      .select("name", "category", "price")
      .limit(10);

    const productContext = products
      .map((p) => `${p.name} (${p.category})`)
      .join(", ");

    // Contexto fixo para PrimePlush
    const systemPrompt = `Você é um atendente amigável da PrimePlush, uma loja de pelúcias e brinquedos. Ajude os clientes com dúvidas sobre nossos produtos. Alguns dos nossos produtos: ${productContext}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: req.body.message },
      ],
      max_tokens: 150,
    });
    console.log(`✅ Resposta OpenAI recebida para PrimePlush!`);
    res.json({ text: completion.choices[0].message.content });
  } catch (e) {
    console.error("❌ ERRO OpenAI:", e.message);
    console.error("Detalhes:", e.response?.data || e);
    res.json({ text: "Desculpe, estou com problemas de conexão." });
  }
});

// --- OTIMIZAÇÃO DE FILA DE COZINHA COM IA ---

// Cache da otimização de cozinha
let kitchenCache = {
  orders: [],
  reasoning: "",
  aiEnabled: false,
  lastOrderIds: "", // Hash dos IDs para detectar mudanças
  timestamp: 0,
};

app.get("/api/ai/kitchen-priority", async (req, res) => {
  // Single-tenant

  if (!openai) {
    console.log("❌ OpenAI não inicializada - retornando ordem padrão");
    // Se IA indisponível, retorna ordem cronológica normal
    try {
      const orders = await db("orders")
        .where({ status: "active" })
        .orderBy("timestamp", "asc")
        .select("*");

      return res.json({
        orders: orders.map((o) => ({ ...o, items: parseJSON(o.items) })),
        aiEnabled: false,
        message: "IA indisponível - ordem cronológica",
      });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao buscar pedidos" });
    }
  }

  try {
    // 1. Busca pedidos ativos (não finalizados) - ORDENADOS DO MAIS ANTIGO PARA O MAIS RECENTE
    // Single-tenant: busca todos os pedidos ativos
    const orders = await db("orders")
      .where({ status: "active" })
      .orderBy("timestamp", "asc")
      .select("*");

    if (orders.length === 0) {
      kitchenCache = {
        orders: [],
        reasoning: "",
        aiEnabled: true,
        lastOrderIds: "",
        timestamp: Date.now(),
      };
      return res.json({
        orders: [],
        aiEnabled: true,
        message: "Nenhum pedido pendente",
      });
    }

    // 2. Verifica se houve mudanças (novo pedido ou pedido concluído)
    const currentOrderIds = orders
      .map((o) => o.id)
      .sort()
      .join(",");

    if (kitchenCache.lastOrderIds === currentOrderIds) {
      console.log(
        "♻️ Cache válido - retornando otimização anterior (sem chamar IA)",
      );
      return res.json({
        orders: kitchenCache.orders,
        aiEnabled: kitchenCache.aiEnabled,
        reasoning: kitchenCache.reasoning,
        cached: true,
        cacheAge:
          Math.round((Date.now() - kitchenCache.timestamp) / 1000) + "s",
      });
    }

    console.log("🍳 Mudança detectada - recalculando com IA...");
    console.log(`📋 ${orders.length} pedido(s) na fila`);

    // 2. Busca informações dos produtos para calcular complexidade
    const products = await db("products").select("*");
    const productMap = {};
    products.forEach((p) => {
      productMap[p.id] = p;
    });

    // 3. Prepara dados dos pedidos para IA analisar
    const orderDetails = orders.map((order) => {
      const items = parseJSON(order.items);
      const itemCount = items.reduce((sum, item) => sum + getItemQuantity(item), 0);

      // Calcula "peso" do pedido (quantidade x complexidade estimada)
      const categories = items.map(
        (item) => productMap[getItemProductId(item)]?.category || "outro",
      );
      const hasHotFood = categories.some((c) =>
        ["Pastel", "Hambúrguer", "Pizza"].includes(c),
      );
      const hasColdFood = categories.some((c) =>
        ["Bebida", "Suco", "Sobremesa"].includes(c),
      );

      return {
        id: order.id,
        timestamp: order.timestamp,
        customerName: order.userName,
        itemCount: itemCount,
        items: items.map((i) => i.name).join(", "),
        hasHotFood: hasHotFood,
        hasColdFood: hasColdFood,
        observation: order.observation, // Adiciona a observação aqui
        minutesWaiting: Math.round(
          (Date.now() - new Date(order.timestamp).getTime()) / 60000,
        ),
      };
    });

    // 4. Monta prompt para IA otimizar ordem
    const ordersText = orderDetails
      .map(
        (o, idx) =>
          `${idx + 1}. Pedido ${o.id} (${o.customerName})
   - Aguardando: ${o.minutesWaiting} min
   - Itens: ${o.itemCount} (${o.items})
   - Tipo: ${o.hasHotFood ? "🔥 Quente" : ""} ${o.hasColdFood ? "❄️ Frio" : ""}
   ${o.observation ? `- OBS: ${o.observation}` : ""}`,
      )
      .join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Você é um assistente de cozinha especializado em otimizar a ordem de preparo de pedidos.

⚠️ REGRA FUNDAMENTAL (INEGOCIÁVEL):
Pedido mais antigo (maior tempo de espera) DEVE aparecer PRIMEIRO na fila. SEMPRE!

REGRAS DE PRIORIZAÇÃO (EM ORDEM DE IMPORTÂNCIA):
1. ⏰ TEMPO DE ESPERA É PRIORIDADE MÁXIMA: Pedidos mais antigos (aguardando há mais tempo) DEVEM vir PRIMEIRO na fila
2. 🚨 Pedidos com >10 minutos de espera são CRÍTICOS e NÃO podem ser ultrapassados por nenhum outro
3. 🎯 Pedidos com >5 minutos esperando SÃO PRIORITÁRIOS e devem estar no topo da fila
4. ⚖️ JUSTIÇA: Ordem cronológica (FIFO - First In, First Out) tem prioridade ALTA sobre eficiência
5. ⚡ EXCEÇÃO LIMITADA: Apenas pedidos MUITO rápidos (1 única bebida/suco) podem ser adiantados em 1-2 posições
6. 🔥 Agrupe pedidos similares APENAS se tiverem tempo de espera semelhante (diferença <3 min)

LÓGICA DE ORDENAÇÃO RIGOROSA:
- Ordene SEMPRE do mais antigo (mais minutos esperando) para o mais recente
- O pedido #1 da lista (mais antigo) NUNCA pode sair da posição 1, exceto por bebida única
- Um pedido pode avançar APENAS 1-2 posições, NUNCA vai para o fim da fila
- Só faça micro-ajustes se ganhar eficiência SEM prejudicar quem está esperando há mais tempo
- Um pedido de 15 minutos NUNCA deve ficar atrás de um de 5 minutos
- Um pedido de 8 minutos NUNCA deve ficar atrás de um de 2 minutos
- Respeite a ordem de chegada (FIFO) como BASE ABSOLUTA

LIMITE DE REORDENAÇÃO:
- Pedido pode subir no máximo 2 posições (ex: #5 pode ir para #3, mas não para #1)
- Pedido NUNCA pode descer mais de 2 posições (ex: #2 pode ir para #4, mas não para #7)
- Se não houver ganho claro de eficiência, MANTENHA a ordem original

RESPONDA NO FORMATO JSON:
{
  "priorityOrder": ["order_123", "order_456", ...],
  "reasoning": "Explicação breve da estratégia"
}

Retorne APENAS o JSON, sem texto adicional.`,
        },
        {
          role: "user",
          content: `Otimize a ordem de preparo destes pedidos (ORDENADOS DO MAIS ANTIGO PARA O MAIS RECENTE):\n\n${ordersText}\n\nLEMBRETE: Priorize SEMPRE os pedidos com mais tempo de espera! O primeiro da lista está esperando há mais tempo.`,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    const aiResponse = completion.choices[0].message.content.trim();
    console.log("🤖 Resposta IA:", aiResponse);

    // 5. Parse da resposta JSON da IA
    let aiSuggestion;
    try {
      // Remove markdown code blocks se existir
      const cleanJson = aiResponse
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "");
      aiSuggestion = JSON.parse(cleanJson);
    } catch (parseError) {
      console.error("❌ Erro ao parsear resposta da IA:", parseError);
      // Fallback: ordem cronológica
      return res.json({
        orders: orders.map((o) => ({ ...o, items: parseJSON(o.items) })),
        aiEnabled: true,
        message: "IA falhou - usando ordem cronológica",
        reasoning: "Erro ao processar sugestão da IA",
      });
    }

    // 6. Reorganiza pedidos conforme IA sugeriu
    const orderMap = {};
    orders.forEach((o) => {
      orderMap[o.id] = o;
    });

    const optimizedOrders = aiSuggestion.priorityOrder
      .map((orderId) => orderMap[orderId])
      .filter((o) => o !== undefined) // Remove IDs inválidos
      .map((o) => ({ ...o, items: parseJSON(o.items) }));

    // 7. VALIDAÇÃO: Garante que pedidos antigos não foram muito atrasados pela IA
    const originalOldest = orders[0]; // Pedido mais antigo (deveria ser o primeiro)
    const optimizedOldestIndex = optimizedOrders.findIndex(
      (o) => o.id === originalOldest?.id,
    );

    // Se o pedido mais antigo foi movido para posição >2, REVERTE para ordem cronológica
    if (optimizedOldestIndex > 2) {
      console.log(
        `⚠️ IA moveu pedido mais antigo (${originalOldest.id}) para posição ${
          optimizedOldestIndex + 1
        } - REVERTENDO para ordem cronológica`,
      );
      return res.json({
        orders: orders.map((o) => ({ ...o, items: parseJSON(o.items) })),
        aiEnabled: false,
        message: "IA tentou atrasar pedido antigo - usando ordem cronológica",
        reasoning: "Segurança: Pedido mais antigo não pode ser muito atrasado",
      });
    }

    console.log(
      `✅ Ordem otimizada pela IA: ${optimizedOrders
        .map((o) => o.id)
        .join(", ")}`,
    );
    console.log(
      `✅ Validação: Pedido mais antigo (${
        originalOldest?.id
      }) está na posição ${optimizedOldestIndex + 1}`,
    );

    // Salva no cache
    kitchenCache = {
      orders: optimizedOrders,
      reasoning: aiSuggestion.reasoning || "Ordem otimizada pela IA",
      aiEnabled: true,
      lastOrderIds: currentOrderIds,
      timestamp: Date.now(),
    };

    res.json({
      orders: optimizedOrders,
      aiEnabled: true,
      reasoning: aiSuggestion.reasoning || "Ordem otimizada pela IA",
      originalOrder: orders.map((o) => o.id),
      optimizedOrder: optimizedOrders.map((o) => o.id),
      cached: false,
    });
  } catch (e) {
    console.error("❌ ERRO na otimização de cozinha:", e.message);

    // Fallback: retorna ordem cronológica
    try {
      const orders = await db("orders")
        .where({ status: "active" })
        .orderBy("timestamp", "asc")
        .select("*");

      res.json({
        orders: orders.map((o) => ({ ...o, items: parseJSON(o.items) })),
        aiEnabled: false,
        message: "Erro na IA - usando ordem cronológica",
        error: e.message,
      });
    } catch (dbError) {
      res.status(500).json({ error: "Erro ao buscar pedidos" });
    }
  }
});

// --- ANÁLISE INTELIGENTE DE ESTOQUE E VENDAS (Admin) ---

app.get("/api/ai/inventory-analysis", async (req, res) => {
  console.log(`📊 [INVENTORY-ANALYSIS] (single-tenant)`);

  if (!openai) {
    return res.status(503).json({ error: "IA indisponível no momento" });
  }

  try {
    console.log(
      `🤖 Iniciando análise inteligente de estoque (single-tenant)...`,
    );

    // 1. Buscar todos os produtos
    const products = await db("products").select("*").orderBy("category");

    // 2. Buscar histórico completo de pedidos pagos
    const orders = await db("orders")
      .whereIn("paymentStatus", ["paid", "approved"])
      .select("*")
      .orderBy("timestamp", "desc");

    // Calcular período de análise
    const oldestOrder =
      orders.length > 0
        ? new Date(orders[orders.length - 1].timestamp)
        : new Date();
    const newestOrder =
      orders.length > 0 ? new Date(orders[0].timestamp) : new Date();
    const daysDiff = Math.ceil(
      (newestOrder - oldestOrder) / (1000 * 60 * 60 * 24),
    );
    const analysisperiod =
      daysDiff > 0
        ? `${daysDiff} dias (desde ${oldestOrder.toLocaleDateString("pt-BR")})`
        : "período completo";

    // 3. Calcular estatísticas de vendas por produto
    const salesStats = {};
    products.forEach((p) => {
      salesStats[p.id] = {
        name: p.name,
        category: p.category,
        price: parseFloat(p.price),
        stock: p.stock,
        totalSold: 0,
        revenue: 0,
        orderCount: 0,
      };
    });

    // Contar vendas
    orders.forEach((order) => {
      const items = parseJSON(order.items);
      items.forEach((item) => {
        const productId = getItemProductId(item);
        if (salesStats[productId]) {
          const quantity = getItemQuantity(item);
          salesStats[productId].totalSold += quantity;
          salesStats[productId].revenue +=
            (item.price || 0) * quantity;
          salesStats[productId].orderCount += 1;
        }
      });
    });

    // 4. Preparar dados para análise da IA
    const totalRevenue = Object.values(salesStats).reduce(
      (sum, p) => sum + p.revenue,
      0,
    );
    const averageOrderValue =
      orders.length > 0 ? totalRevenue / orders.length : 0;

    const analysisData = {
      totalProducts: products.length,
      totalOrders: orders.length,
      totalRevenue: totalRevenue.toFixed(2),
      averageOrderValue: averageOrderValue.toFixed(2),
      period: analysisperiod,
      products: Object.values(salesStats).map((p) => ({
        name: p.name,
        category: p.category,
        price: p.price,
        stock: Number(p.stock) || 0,
        totalSold: p.totalSold,
        revenue: p.revenue.toFixed(2),
        averagePerOrder:
          p.orderCount > 0 ? (p.totalSold / p.orderCount).toFixed(1) : 0,
      })),
    };

    // Prompt estruturado para a IA
    const prompt = `Você é um consultor de negócios especializado em food service. Analise os dados HISTÓRICOS COMPLETOS de vendas:

📊 RESUMO FINANCEIRO:
- Período analisado: ${analysisData.period}
- Total de produtos no catálogo: ${analysisData.totalProducts}
- Total de pedidos PAGOS: ${analysisData.totalOrders}
- Receita total: R$ ${analysisData.totalRevenue}
- Ticket médio: R$ ${analysisData.averageOrderValue}

📦 DESEMPENHO POR PRODUTO:
${analysisData.products
  .sort((a, b) => parseFloat(b.revenue) - parseFloat(a.revenue))
  .map(
    (p) =>
      `• ${p.name} (${p.category}):
    - Preço: R$ ${p.price}
    - Estoque atual: ${p.stock}
    - Total vendido: ${p.totalSold} unidades
    - Receita gerada: R$ ${p.revenue}
    - Média por pedido: ${p.averagePerOrder}`,
  )
  .join("\n")}

Por favor, forneça uma análise completa e acionável sobre:

1. 🏆 TOP 3 PRODUTOS: Quais são os campeões de venda e por que são importantes para o negócio?

2. 📈 CRESCIMENTO: Quais produtos/categorias têm potencial de crescer ainda mais?

3. 📉 PRODUTOS LENTOS: Quais vendem pouco e devem ser descontinuados ou reformulados?

4. 🚨 GESTÃO DE ESTOQUE: Quais produtos precisam de atenção no estoque (reposição ou ajuste)?

5. 💡 NOVOS PRODUTOS: Baseado no histórico, que novos produtos você recomendaria adicionar ao cardápio?

6. 💰 OTIMIZAÇÃO DE RECEITA: Sugestões práticas para aumentar o faturamento (preços, combos, promoções)?

Seja específico, use dados concretos e foque em AÇÕES PRÁTICAS que o admin pode implementar HOJE.

5. 💰 OPORTUNIDADES DE RECEITA: Ajustes de preço ou combos que podem aumentar o faturamento?

Seja direto, prático e use emojis. Priorize ações que o administrador pode tomar HOJE.`;

    // 6. Chamar OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é um consultor de negócios especializado em análise de vendas e gestão de estoque para restaurantes e food service. Seja prático, direto e focado em ações.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.7,
    });

    const analysis = completion.choices[0].message.content;

    // 7. Retornar análise + dados brutos
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      period: analysisData.period,
      summary: {
        totalProducts: analysisData.totalProducts,
        totalOrders: analysisData.totalOrders,
        totalRevenue: analysisData.totalRevenue,
        averageOrderValue: analysisData.averageOrderValue,
        lowStock: products.filter((p) => Number(p.stock) <= 5)
          .length,
        outOfStock: products.filter((p) => p.stock === 0).length,
        backorderedProducts: products.filter(
          (p) => Number(p.stock) < 0,
        ).length,
      },
      analysis: analysis,
      rawData: salesStats, // Para o frontend criar gráficos se quiser
    });
  } catch (error) {
    console.error("❌ Erro na análise de estoque:", error);
    res.status(500).json({
      error: "Erro ao processar análise",
      message: error.message,
    });
  }
});

// ========== SUPER ADMIN DASHBOARD (MULTI-TENANCY) ==========
// Endpoint protegido que ignora filtro de loja e retorna visão global
app.get("/api/super-admin/dashboard", async (req, res) => {
  try {
    // Verifica autenticação de Super Admin via header
    const superAdminPassword = req.headers["x-super-admin-password"];
    if (!SUPER_ADMIN_PASSWORD) {
      return res.status(503).json({
        error:
          "Super Admin não configurado. Defina SUPER_ADMIN_PASSWORD no servidor.",
      });
    }
    if (superAdminPassword !== SUPER_ADMIN_PASSWORD) {
      return res.status(401).json({
        error: "Acesso negado. Senha de Super Admin inválida.",
      });
    }
    console.log("🔐 Super Admin acessando dashboard global...");
    // Single-tenant: estatísticas globais
    const orderCount = await db("orders").count("id as count").first();
    const revenue = await db("orders")
      .whereIn("paymentStatus", ["paid", "authorized"])
      .sum("total as total")
      .first();
    const productCount = await db("products").count("id as count").first();
    const activeOrders = await db("orders")
      .where({ status: "active" })
      .count("id as count")
      .first();
    const globalStats = {
      total_orders: Number(orderCount.count) || 0,
      total_revenue: parseFloat(revenue.total) || 0,
      total_products: Number(productCount.count) || 0,
      total_active_orders: Number(activeOrders.count) || 0,
    };
    console.log(`✅ Dashboard gerado: single-tenant`);
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      global_stats: globalStats,
    });
  } catch (error) {
    console.error("❌ Erro no Super Admin Dashboard:", error);
    res.status(500).json({
      error: "Erro ao gerar dashboard",
      message: error.message,
    });
  }
});

// 📊 Top 5 Produtos Mais Vendidos de uma Loja
app.get("/api/super-admin/top-products", async (req, res) => {
  try {
    // Verifica autenticação de Super Admin
    const superAdminPassword = req.headers["x-super-admin-password"];

    if (!SUPER_ADMIN_PASSWORD) {
      return res.status(503).json({
        error: "Super Admin não configurado.",
      });
    }

    if (superAdminPassword !== SUPER_ADMIN_PASSWORD) {
      return res.status(401).json({
        error: "Acesso negado. Senha de Super Admin inválida.",
      });
    }

    // Single-tenant
    console.log(`📊 [TOP-PRODUCTS] Buscando top produtos (single-tenant)`);

    // Busca todos os pedidos pagos (single-tenant)
    const orders = await db("orders")
      .whereIn("paymentStatus", ["paid", "authorized"])
      .select("items");

    // Agrupa vendas por produto
    const productSales = {};

    orders.forEach((order) => {
      const items = parseJSON(order.items);
      items.forEach((item) => {
        const productId = getItemProductId(item);
        if (!productId) return;

        if (!productSales[productId]) {
          productSales[productId] = {
            name: item.name,
            sold: 0,
            revenue: 0,
            orderCount: 0,
          };
        }
        const quantity = getItemQuantity(item);
        productSales[productId].sold += quantity;
        productSales[productId].revenue +=
          (item.price || 0) * quantity;
        productSales[productId].orderCount += 1;
      });
    });

    // Converte para array e ordena por quantidade vendida
    const topProducts = Object.values(productSales)
      .sort((a, b) => b.sold - a.sold)
      .slice(0, 5)
      .map((p) => ({
        name: p.name,
        sold: p.sold,
        revenue: parseFloat(p.revenue.toFixed(2)),
      }));

    console.log(`✅ [TOP-PRODUCTS] ${topProducts.length} produtos retornados`);

    res.json(topProducts);
  } catch (error) {
    console.error("❌ Erro ao buscar top products:", error);
    res.status(500).json({
      error: "Erro ao buscar produtos mais vendidos",
      message: error.message,
    });
  }
});

// 📈 Histórico de Vendas (Últimos N Dias)
app.get("/api/super-admin/sales-history", async (req, res) => {
  try {
    // Verifica autenticação de Super Admin
    const superAdminPassword = req.headers["x-super-admin-password"];

    if (!SUPER_ADMIN_PASSWORD) {
      return res.status(503).json({
        error: "Super Admin não configurado.",
      });
    }

    if (superAdminPassword !== SUPER_ADMIN_PASSWORD) {
      return res.status(401).json({
        error: "Acesso negado. Senha de Super Admin inválida.",
      });
    }

    // Single-tenant
    const days = parseInt(req.query.days) || 7;

    console.log(
      `📈 [SALES-HISTORY] Buscando últimos ${days} dias (single-tenant)`,
    );

    // Calcula data inicial
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Busca pedidos pagos do período (single-tenant)
    const orders = await db("orders")
      .whereIn("paymentStatus", ["paid", "authorized"])
      .where("timestamp", ">=", startDate.toISOString())
      .select("timestamp", "total");

    // Agrupa por dia
    const salesByDay = {};

    orders.forEach((order) => {
      const date = new Date(order.timestamp);
      const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD

      if (!salesByDay[dateStr]) {
        salesByDay[dateStr] = 0;
      }
      salesByDay[dateStr] += parseFloat(order.total) || 0;
    });

    // Converte para array e adiciona nome do dia da semana
    const dayNames = [
      "Domingo",
      "Segunda",
      "Terça",
      "Quarta",
      "Quinta",
      "Sexta",
      "Sábado",
    ];

    const salesHistory = Object.entries(salesByDay)
      .map(([date, value]) => {
        const dateObj = new Date(date + "T12:00:00"); // Meio-dia para evitar problemas de timezone
        return {
          day: dayNames[dateObj.getDay()],
          date: date,
          value: parseFloat(value.toFixed(2)),
        };
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log(`✅ [SALES-HISTORY] ${salesHistory.length} dias com vendas`);

    res.json(salesHistory);
  } catch (error) {
    console.error("❌ Erro ao buscar sales history:", error);
    res.status(500).json({
      error: "Erro ao buscar histórico de vendas",
      message: error.message,
    });
  }
});

// Endpoint para buscar todos os pedidos
app.get("/api/orders", async (req, res) => {
  try {
    const orders = await db("orders").orderBy("timestamp", "desc");
    const enrichedOrders = await enrichOrdersWithDelivery(orders);
    const parsedOrders = enrichedOrders.map((o) => normalizeOrderResponse(o));
    res.json(parsedOrders);
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

// // 🔧 ENDPOINT TEMPORÁRIO: Atualizar credenciais do sushiman1
// app.get("/api/admin/update-sushiman1-credentials", async (req, res) => {
//   try {
//     console.log("🔧 Atualizando credenciais da loja sushiman1...");

//     const newAccessToken =
//       "APP_USR-2380991543282785-120915-186724196695d70b571258710e1f9645-272635919";
//     const newDeviceId = "GERTEC_MP35P__8701012151238699";

//     // Loja única: não atualiza mais tabela stores
//     // Se necessário, atualize as variáveis de ambiente manualmente na Render
//     res.json({
//       success: true,
//       message:
//         "Loja única: atualize as credenciais nas variáveis de ambiente da Render.",
//       mp_access_token: newAccessToken,
//       mp_device_id: newDeviceId,
//     });

//     // Verifica se foi atualizado
//     // Loja única: não busca mais na tabela stores

//     console.log("✅ Credenciais do sushiman1 atualizadas com sucesso!");
//     console.log(
//       `   Access Token: ${updatedStore.mp_access_token.substring(0, 20)}...`,
//     );
//     console.log(`   Device ID: ${updatedStore.mp_device_id}`);

//     res.json({
//       success: true,
//       message: "Credenciais do sushiman1 atualizadas com sucesso!",
//       store: {
//         id: updatedStore.id,
//         name: updatedStore.name,
//         mp_device_id: updatedStore.mp_device_id,
//         mp_access_token: updatedStore.mp_access_token.substring(0, 20) + "...",
//       },
//     });
//   } catch (error) {
//     console.error("❌ Erro ao atualizar credenciais:", error);
//     res.status(500).json({
//       success: false,
//       error: "Erro ao atualizar credenciais",
//       message: error.message,
//     });
//   }
// });

// ==========================================
// PAGAMENTO ONLINE COM SDK MERCADO PAGO
// ==========================================

// Criar preferência de pagamento (Checkout Pro - redireciona para página do MP)
app.post("/api/payment-online/create-preference", async (req, res) => {
  try {
    if (!preferenceClient) {
      return res.status(503).json({
        error: "SDK MercadoPago não configurado",
      });
    }

    const { items, orderId, payerEmail, payerName } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Items são obrigatórios" });
    }

    // Calcula o total
    const total = items.reduce(
      (sum, item) => sum + item.price * getItemQuantity(item),
      0,
    );

    console.log(
      `💳 [ONLINE] Criando preferência de pagamento: R$ ${total.toFixed(2)}`,
    );

    const preference = await preferenceClient.create({
      body: {
        items: items.map((item) => ({
          title: item.name,
          quantity: getItemQuantity(item),
          unit_price: item.price,
          currency_id: "BRL",
        })),
        payer: {
          email: payerEmail || "cliente@primeplush.com",
          name: payerName || "Cliente",
        },
        external_reference: orderId,
        back_urls: {
          success: `${process.env.FRONTEND_URL || "https://primeplush.com.br"}/payment-success`,
          failure: `${process.env.FRONTEND_URL || "https://primeplush.com.br"}/payment-failure`,
          pending: `${process.env.FRONTEND_URL || "https://primeplush.com.br"}/payment-pending`,
        },
        auto_return: "approved",
        notification_url: `${process.env.BACKEND_URL || "https://backendprimeplush.onrender.com"}/api/webhooks/mercadopago`,
      },
    });

    console.log(`✅ Preferência criada: ${preference.id}`);

    res.json({
      preferenceId: preference.id,
      initPoint: preference.init_point,
      sandboxInitPoint: preference.sandbox_init_point,
    });
  } catch (error) {
    console.error("❌ Erro ao criar preferência:", error);
    res.status(500).json({
      error: "Erro ao criar preferência de pagamento",
      message: error.message,
    });
  }
});

// Criar pagamento PIX direto (retorna QR Code)
app.post("/api/payment-online/create-pix-direct", async (req, res) => {
  try {
    if (!paymentClient) {
      return res.status(503).json({
        error: "SDK MercadoPago não configurado",
      });
    }

    const { amount, description, orderId, payerEmail } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valor inválido" });
    }

    console.log(`💚 [PIX ONLINE] Gerando QR Code: R$ ${amount.toFixed(2)}`);

    const payment = await paymentClient.create({
      body: {
        transaction_amount: parseFloat(amount),
        description: description || `Pedido ${orderId}`,
        payment_method_id: "pix",
        payer: {
          email: payerEmail || "cliente@primeplush.com",
        },
        external_reference: orderId,
        notification_url: `${process.env.BACKEND_URL || "https://backendprimeplush.onrender.com"}/api/webhooks/mercadopago`,
      },
    });

    console.log(`✅ PIX criado: ${payment.id}`);

    res.json({
      paymentId: payment.id,
      status: payment.status,
      qrCode: payment.point_of_interaction?.transaction_data?.qr_code,
      qrCodeBase64:
        payment.point_of_interaction?.transaction_data?.qr_code_base64,
      ticketUrl: payment.point_of_interaction?.transaction_data?.ticket_url,
    });
  } catch (error) {
    console.error("❌ Erro ao criar PIX:", error);
    res.status(500).json({
      error: "Erro ao criar pagamento PIX",
      message: error.message,
    });
  }
});

// Criar pagamento com cartão de crédito (necessita token do cartão do frontend)
app.post("/api/payment-online/create-card-payment", async (req, res) => {
  try {
    if (!paymentClient) {
      return res.status(503).json({
        error: "SDK MercadoPago não configurado",
      });
    }

    const {
      token,
      amount,
      description,
      orderId,
      installments,
      payerEmail,
      issuerId,
      paymentMethodId,
    } = req.body;

    if (!token || !amount) {
      return res.status(400).json({ error: "Token e valor são obrigatórios" });
    }

    console.log(
      `💳 [CARD ONLINE] Processando pagamento: R$ ${amount.toFixed(2)}`,
    );

    const payment = await paymentClient.create({
      body: {
        transaction_amount: parseFloat(amount),
        token: token,
        description: description || `Pedido ${orderId}`,
        installments: parseInt(installments) || 1,
        payment_method_id: paymentMethodId || "visa",
        issuer_id: issuerId,
        payer: {
          email: payerEmail || "cliente@primeplush.com",
        },
        external_reference: orderId,
        notification_url: `${process.env.BACKEND_URL || "https://backendprimeplush.onrender.com"}/api/webhooks/mercadopago`,
      },
    });

    console.log(`✅ Pagamento cartão criado: ${payment.id}`);
    console.log(`   Status: ${payment.status}`);
    console.log(`   Status Detail: ${payment.status_detail}`);

    res.json({
      paymentId: payment.id,
      status: payment.status,
      statusDetail: payment.status_detail,
      approved: payment.status === "approved",
    });
  } catch (error) {
    console.error("❌ Erro ao processar pagamento:", error);
    res.status(500).json({
      error: "Erro ao processar pagamento com cartão",
      message: error.message,
    });
  }
});

// Verificar status de pagamento (qualquer tipo)
app.get("/api/payment-online/status/:paymentId", async (req, res) => {
  try {
    if (!paymentClient) {
      return res.status(503).json({
        error: "SDK MercadoPago não configurado",
      });
    }

    const { paymentId } = req.params;

    console.log(`🔍 [STATUS ONLINE] Verificando: ${paymentId}`);

    const payment = await paymentClient.get({ id: paymentId });

    console.log(`   Status: ${payment.status}`);

    res.json({
      paymentId: payment.id,
      status: payment.status,
      statusDetail: payment.status_detail,
      approved: payment.status === "approved",
      externalReference: payment.external_reference,
    });
  } catch (error) {
    console.error("❌ Erro ao verificar status:", error);
    res.status(500).json({
      error: "Erro ao verificar status do pagamento",
      message: error.message,
    });
  }
});

// ==========================================

app.put("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  const { name, email, cpf, cep, address, phone, password, fullAccess, monthlyPayment } = req.body;
  if (!name || !email || !cpf || !cep || !address || !phone || !password) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios" });
  }
  try {
    // Verifica se o usuário existe
    const user = await db("users").where({ id }).first();
    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }
    // Atualiza os dados do usuário
    await db("users")
      .where({ id })
      .update({
        name: name.trim(),
        email: email.trim(),
        cpf: String(cpf).replace(/\D/g, ""),
        cep: cep.trim(),
        address: address.trim(),
        phone: phone.trim(),
        password: password,
        ...(fullAccess !== undefined ? { fullAccess: isTruthyDb(fullAccess) } : {}),
        ...(monthlyPayment !== undefined
          ? { monthlyPayment: isTruthyDb(monthlyPayment) }
          : {}),
      });
    // Retorna o usuário atualizado
    const updatedUser = await db("users").where({ id }).first();
    res.json({
      success: true,
      user: normalizeUserResponse(updatedUser),
    });
  } catch (e) {
    console.error("Erro ao atualizar usuário:", e);
    res.status(500).json({ error: "Erro ao atualizar usuário" });
  }
});

// Dummy endpoint para Point Smart 2 (apenas evita erro 404)
app.post("/api/point/configure", (req, res) => {
  res.json({
    success: true,
    message: "Configuração de Point ignorada (dummy endpoint)",
  });
});

// --- Inicialização ---
console.log("🚀 Iniciando servidor...");
Promise.all([initDatabase(), initRedis()])
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Servidor rodando na porta ${PORT}`);
      console.log(
        `🔐 JWT: ${JWT_SECRET ? "Configurado" : "⚠️ NÃO CONFIGURADO"}`,
      );
      console.log(`💾 Cache: ${useRedis ? "Redis" : "Map em memória"}`);
    });
  })
  .catch((err) => {
    console.error("❌ ERRO FATAL ao iniciar servidor:", err);
    process.exit(1);
  });
