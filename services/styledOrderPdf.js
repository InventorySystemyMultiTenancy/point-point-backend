import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function generateStyledOrderPdf(order) {
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  const buffers = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
  });

  // Centralizar logo com espaçamento adequado
  const logoPath = path.join(process.cwd(), "public", "logo.png");
  let y = 40;
  if (fs.existsSync(logoPath)) {
    const logoWidth = 120;
    const logoHeight = 120;
    const pageWidth = doc.page.width;
    const xLogo = (pageWidth - logoWidth) / 2;
    doc.image(logoPath, xLogo, y, { width: logoWidth, height: logoHeight });
    y += logoHeight + 30; // Mais espaço após logo
  }

  // Título
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .text(
      "ORÇAMENTO (entre em contato para cotar seu frete 11-942058445)",
      0,
      y,
      {
        align: "center",
      },
    );
  y += 40;

  // Dados do cliente
  const nomeCliente =
    order.userName ||
    order.name ||
    order.cliente ||
    order.customerName ||
    order.customer ||
    "-";
  const emailCliente =
    order.email ||
    order.customerEmail ||
    order.userEmail ||
    order.contactEmail ||
    "-";
  const telefoneCliente =
    order.phone ||
    order.telefone ||
    order.customerPhone ||
    order.userPhone ||
    order.contactPhone ||
    "-";
  const enderecoCliente =
    order.address ||
    order.endereco ||
    order.customerAddress ||
    order.userAddress ||
    order.contactAddress ||
    "-";
  const cepCliente =
    order.cep ||
    order.zip ||
    order.customerCep ||
    order.userCep ||
    order.contactCep ||
    "-";
  // Blocos lado a lado com altura dinâmica (evita sobreposição)
  const leftX = 40;
  const rightX = 340;
  const blocoY = y;
  const leftWidth = rightX - leftX - 20;
  const rightWidth = doc.page.width - rightX - 40;

  // --- CPF/CNPJ ---
  let docLabel = "CPF";
  let docValue = "-";
  if (order.cpf && typeof order.cpf === "string") {
    const cleanDoc = order.cpf.replace(/\D/g, "");
    if (cleanDoc.length === 14) docLabel = "CNPJ";
    docValue = order.cpf;
  }

  doc.fontSize(12).font("Helvetica-Bold");
  doc.text("DADOS DO CLIENTE", leftX, blocoY, {
    width: leftWidth,
  });

  let leftCurrentY =
    blocoY + doc.heightOfString("DADOS DO CLIENTE", { width: leftWidth }) + 6;
  const customerLines = [
    `Nome: ${nomeCliente}`,
    `Telefone: ${telefoneCliente}`,
    `E-mail: ${emailCliente}`,
    `Endereço: ${enderecoCliente}`,
    `CEP: ${cepCliente}`,
    `${docLabel}: ${docValue}`,
  ];

  customerLines.forEach((line) => {
    doc.font("Helvetica").fontSize(11);
    doc.text(line, leftX, leftCurrentY, {
      width: leftWidth,
    });
    leftCurrentY += doc.heightOfString(line, { width: leftWidth }) + 4;
  });

  doc.fontSize(12).font("Helvetica-Bold");
  doc.text("FORMA DE PAGAMENTO", rightX, blocoY, { width: rightWidth });

  let rightCurrentY =
    blocoY +
    doc.heightOfString("FORMA DE PAGAMENTO", { width: rightWidth }) +
    6;
  const paymentMain =
    order.paymentType ||
    order.payment_method ||
    order.payment_method_id ||
    order.paymentStatus ||
    "-";

  doc.font("Helvetica").fontSize(11);
  doc.text(paymentMain, rightX, rightCurrentY, {
    width: rightWidth,
  });
  rightCurrentY += doc.heightOfString(paymentMain, { width: rightWidth }) + 4;

  // Detalhes extra para pagamento presencial
  if (paymentMain === "presencial") {
    const tipoPagamento =
      order.paymentMethod ||
      order.payment_method ||
      order.payment_method_id ||
      "-";
    const vezes =
      order.installments ||
      order.parcelas ||
      order.qtdParcelas ||
      order.paymentInstallments ||
      1;

    let tipoDesc = "";
    if (typeof tipoPagamento === "string") {
      if (tipoPagamento.toLowerCase().includes("pix")) tipoDesc = "PIX";
      else if (tipoPagamento.toLowerCase().includes("debito"))
        tipoDesc = "Cartão Débito";
      else if (tipoPagamento.toLowerCase().includes("credito"))
        tipoDesc = "Cartão Crédito";
      else tipoDesc = tipoPagamento;
    }

    const tipoText = `Tipo: ${tipoDesc}`;
    doc.fontSize(11).font("Helvetica").text(tipoText, rightX, rightCurrentY, {
      width: rightWidth,
    });
    rightCurrentY += doc.heightOfString(tipoText, { width: rightWidth }) + 4;

    if (vezes > 1) {
      const parceladoText = `Parcelado: ${vezes}x`;
      doc
        .fontSize(11)
        .font("Helvetica")
        .text(parceladoText, rightX, rightCurrentY, {
          width: rightWidth,
        });
      rightCurrentY +=
        doc.heightOfString(parceladoText, { width: rightWidth }) + 4;
    }
  }

  y = Math.max(leftCurrentY, rightCurrentY) + 16;

  // Tabela de produtos
  doc.font("Helvetica-Bold").fontSize(14).text("PRODUTOS", 40, y);
  y += 24;
  const pageRight = doc.page.width - doc.page.margins.right;
  const tableX = doc.page.margins.left;
  const qtyWidth = 44;
  const unitWidth = 78;
  const subtotalWidth = 82;
  const gap = 10;
  const subtotalX = pageRight - subtotalWidth;
  const unitX = subtotalX - gap - unitWidth;
  const qtyX = unitX - gap - qtyWidth;
  const productWidth = qtyX - gap - tableX;

  doc
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("Produto", tableX, y, { width: productWidth })
    .text("Qtd", qtyX, y, { width: qtyWidth, align: "right" })
    .text("Valor Unit.", unitX, y, { width: unitWidth, align: "right" })
    .text("Subtotal", subtotalX, y, {
      width: subtotalWidth,
      align: "right",
    });
  y += 18;
  // Exibe produtos comprados
  (order.items || []).forEach((item) => {
    const nome =
      item.name ||
      item.produto ||
      item.title ||
      item.product ||
      item.descricao ||
      item.description ||
      "-";
    const qtd = item.quantity || item.qtd || item.amount || 1;
    const valor =
      item.price !== undefined
        ? item.price
        : item.valor_unit || item.unit_price || 0;
    const numericQtd = toNumber(qtd) || 1;
    const numericValor = toNumber(valor);
    const rowTop = y;
    const productOptions = {
      width: productWidth,
      height: 28,
      ellipsis: true,
    };
    doc.font("Helvetica").fontSize(11);
    doc
      .text(nome, tableX, rowTop, productOptions)
      .text(String(qtd), qtyX, rowTop, {
        width: qtyWidth,
        align: "right",
      })
      .text(`R$ ${numericValor.toFixed(2)}`, unitX, rowTop, {
        width: unitWidth,
        align: "right",
      })
      .text(`R$ ${(numericValor * numericQtd).toFixed(2)}`, subtotalX, rowTop, {
        width: subtotalWidth,
        align: "right",
      });
    const nameHeight = doc.heightOfString(nome, productOptions);
    y += Math.max(16, Math.min(28, nameHeight)) + 4;
  });

  // Total
  y += 10;
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .text("TOTAL:", unitX, y, { width: unitWidth, align: "right" })
    .text(
      `R$ ${toNumber(order.total !== undefined ? order.total : order.valor_total || 0).toFixed(2)}`,
      subtotalX,
      y,
      { width: subtotalWidth, align: "right" },
    );
  y += 32;

  // Observações
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .text("OBSERVAÇÕES", 40, y)
    .font("Helvetica")
    .fontSize(11)
    .text(
      order.observation || order.observacoes || order.observacao || "-",
      40,
      y + 18,
      { width: 500 },
    );
  y += 44;

  doc.end();
  return done;
}
