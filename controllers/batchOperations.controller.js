const { ObjectId } = require("mongodb");
const { db, client } = require("../db");

const batches = db.collection("batches");
const operations = db.collection("batch_operations");
const sales = db.collection("sales");
const VALID_TYPES = ["CHICK_PLACEMENT", "FEED_ISSUE", "MEDICINE_ISSUE", "EXPENSE", "MORTALITY"];
operations.createIndex({ saleInvoiceId: 1 }, { unique: true, partialFilterExpression: { saleInvoiceId: { $type: "objectId" } } }).catch((error) => console.error("Could not ensure unique batch invoice allocation index:", error.message));
const money = (n) => Number((Number(n || 0)).toFixed(2));

function validDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? null : date;
}

exports.createBatchOperation = async (req, res) => {
  const session = client.startSession();
  let operationId = null;
  try {
    const { batchId } = req.params;
    const body = req.body || {};
    const type = String(body.type || "").toUpperCase();
    const quantity = Number(body.quantity || 0);
    const unitCost = Number(body.unitCost || 0);
    const countsTowardBirds = body.countsTowardBirds !== false;
    let amount = body.amount === undefined ? money(quantity * unitCost) : money(body.amount);
    const date = validDate(body.date);

    if (!ObjectId.isValid(batchId)) return res.status(400).json({ success: false, message: "Valid batch ID is required." });
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ success: false, message: "Invalid operation type." });
    if (!date) return res.status(400).json({ success: false, message: "Invalid operation date." });
    if (![amount, unitCost, quantity].every(Number.isFinite) || amount < 0 || unitCost < 0 || quantity < 0) return res.status(400).json({ success: false, message: "Enter valid non-negative quantity and cost values." });
    if (["CHICK_PLACEMENT", "FEED_ISSUE", "MEDICINE_ISSUE"].includes(type) && quantity <= 0) return res.status(400).json({ success: false, message: "Quantity must be greater than zero." });
    if (type === "CHICK_PLACEMENT" && !Number.isInteger(quantity)) return res.status(400).json({ success: false, message: "Chick placement must be a whole bird count." });
    if (type === "MORTALITY" && (!Number.isInteger(quantity) || quantity <= 0)) return res.status(400).json({ success: false, message: "Mortality must be a whole bird count greater than zero." });
    if (["EXPENSE", "FEED_ISSUE", "MEDICINE_ISSUE", "CHICK_PLACEMENT"].includes(type) && amount < 0) return res.status(400).json({ success: false, message: "Cost cannot be negative." });

    const invoiceId = body.saleInvoiceId ? String(body.saleInvoiceId) : null;
    if (invoiceId && !["CHICK_PLACEMENT", "FEED_ISSUE", "MEDICINE_ISSUE", "EXPENSE"].includes(type)) return res.status(400).json({ success: false, message: "Only cost records can be linked to a sales invoice." });
    if (invoiceId && !ObjectId.isValid(invoiceId)) return res.status(400).json({ success: false, message: "Invalid sales invoice reference." });

    await session.withTransaction(async () => {
      const batch = await batches.findOne({ _id: new ObjectId(batchId) }, { session });
      if (!batch) throw Object.assign(new Error("Batch not found."), { statusCode: 404 });
      const effectiveStatus = batch.status || (batch.active === false ? "COMPLETED" : "ACTIVE");
      if (["HARVESTED", "COMPLETED"].includes(effectiveStatus)) throw Object.assign(new Error("Cannot add farming operations to a harvested or completed batch."), { statusCode: 409 });

      if (invoiceId) {
        const invoice = await sales.findOne({ _id: new ObjectId(invoiceId) }, { session });
        if (!invoice) throw Object.assign(new Error("Linked sales invoice not found."), { statusCode: 404 });
        const invoiceBatch = String(invoice.batch_id || invoice.batchId || "");
        if (invoiceBatch && invoiceBatch !== batchId) throw Object.assign(new Error("Linked invoice belongs to a different batch."), { statusCode: 400 });
        if (batch.farmerId && String(invoice.customer_id || "") !== String(batch.farmerId)) throw Object.assign(new Error("Linked invoice customer does not match this batch farmer."), { statusCode: 400 });
        const alreadyLinked = await operations.findOne({ saleInvoiceId: new ObjectId(invoiceId) }, { session });
        if (alreadyLinked) throw Object.assign(new Error("This sales invoice is already allocated to a batch operation."), { statusCode: 409 });
        // The source sales invoice is the authoritative cost amount; do not re-enter it manually.
        amount = money(invoice.total_amount || 0);
      }

      const currentBirdCount = Number(batch.currentBirdCount ?? batch.chicksQuantity ?? 0);
      if (type === "MORTALITY" && quantity > currentBirdCount) throw Object.assign(new Error(`Mortality (${quantity}) cannot exceed current bird count (${currentBirdCount}).`), { statusCode: 400 });
      const birdDelta = type === "CHICK_PLACEMENT" && countsTowardBirds ? quantity : type === "MORTALITY" ? -quantity : 0;
      const operation = {
        batchId: new ObjectId(batchId), batchCode: batch.batchCode || "", farmerId: batch.farmerId || null,
        farmer: batch.farmer || "", type, quantity, unit: String(body.unit || (type === "MORTALITY" || type === "CHICK_PLACEMENT" ? "birds" : "kg")),
        unitCost: money(unitCost), amount, itemName: String(body.itemName || "").trim(),
        category: String(body.category || "").trim(), date, note: String(body.note || "").trim().slice(0, 1000),
        saleInvoiceId: invoiceId ? new ObjectId(invoiceId) : null,
        countsTowardBirds: type === "CHICK_PLACEMENT" ? countsTowardBirds : false,
        costSource: invoiceId ? "SALES_INVOICE_REFERENCE" : "MANUAL_OPERATIONAL_ENTRY",
        createdAt: new Date(), createdBy: req.user?.id || req.user?._id || null,
      };
      const inserted = await operations.insertOne(operation, { session });
      operationId = inserted.insertedId;
      const update = { $set: { currentBirdCount: currentBirdCount + birdDelta, updatedAt: new Date() } };
      if (type === "MORTALITY") update.$inc = { mortalityCount: quantity };
      if (type === "CHICK_PLACEMENT" && countsTowardBirds) update.$inc = { placedBirdCount: quantity };
      await batches.updateOne({ _id: batch._id }, update, { session });
      operation._id = inserted.insertedId;
    });

    return res.status(201).json({ success: true, message: "Batch operation recorded.", operation: operationId ? await operations.findOne({ _id: operationId }) : null });
  } catch (error) {
    console.error("Create batch operation error:", error);
    const statusCode = error.statusCode || (error.code === 11000 ? 409 : 500);
    return res.status(statusCode).json({ success: false, message: error.code === 11000 ? "This sales invoice is already allocated to a batch operation." : (error.message || "Could not record batch operation.") });
  } finally {
    await session.endSession();
  }
};

exports.getBatchOperations = async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!ObjectId.isValid(batchId)) return res.status(400).json({ success: false, message: "Valid batch ID is required." });
    const batch = await batches.findOne({ _id: new ObjectId(batchId) });
    if (!batch) return res.status(404).json({ success: false, message: "Batch not found." });
    const entries = await operations.find({ batchId: new ObjectId(batchId) }).sort({ date: 1, createdAt: 1 }).toArray();
    const totals = { chick_cost: 0, feed_cost: 0, medicine_cost: 0, other_cost: 0, mortality_count: 0, placed_birds: Number(batch.chicksQuantity || 0) };
    for (const entry of entries) {
      if (entry.type === "CHICK_PLACEMENT") { totals.chick_cost += Number(entry.amount || 0); if (entry.countsTowardBirds !== false) totals.placed_birds += Number(entry.quantity || 0); }
      if (entry.type === "FEED_ISSUE") totals.feed_cost += Number(entry.amount || 0);
      if (entry.type === "MEDICINE_ISSUE") totals.medicine_cost += Number(entry.amount || 0);
      if (entry.type === "EXPENSE") totals.other_cost += Number(entry.amount || 0);
      if (entry.type === "MORTALITY") totals.mortality_count += Number(entry.quantity || 0);
    }
    Object.keys(totals).forEach((key) => { if (key.endsWith("_cost")) totals[key] = money(totals[key]); });
    const totalFarmingCost = money(totals.chick_cost + totals.feed_cost + totals.medicine_cost + totals.other_cost);
    const invoiceFilters = [{ batch_id: new ObjectId(batchId) }, { batch_id: batchId }, { batchId: new ObjectId(batchId) }, { batchId }];
    if (batch.farmerId && ObjectId.isValid(String(batch.farmerId))) invoiceFilters.push({ customer_id: new ObjectId(String(batch.farmerId)) });
    const linkedInvoiceRows = await operations.find({ saleInvoiceId: { $ne: null } }, { projection: { saleInvoiceId: 1 } }).toArray();
    const linkedInvoiceIds = linkedInvoiceRows.map((row) => row.saleInvoiceId);
    const salesInvoices = await sales.find({ $and: [{ $or: invoiceFilters }, { _id: { $nin: linkedInvoiceIds } }] }, { projection: { _id: 1, memoNo: 1, invoiceNo: 1, total_amount: 1, totalAmount: 1, date: 1, customer_id: 1 } }).toArray();
    return res.status(200).json({ success: true, operations: entries, summary: { ...totals, total_farming_cost: totalFarmingCost, current_bird_count: Number(batch.currentBirdCount ?? Math.max(0, Number(batch.chicksQuantity || 0) + Number(batch.placedBirdCount || 0) - Number(batch.mortalityCount || 0))), sales_invoice_count: salesInvoices.length }, salesInvoices });
  } catch (error) {
    console.error("Get batch operations error:", error);
    return res.status(500).json({ success: false, message: "Could not load batch operations." });
  }
};
