const express = require("express");
const { createBatchOperation, getBatchOperations } = require("../controllers/batchOperations.controller");
const router = express.Router();
router.get("/:batchId/operations", getBatchOperations);
router.post("/:batchId/operations", createBatchOperation);
module.exports = router;
