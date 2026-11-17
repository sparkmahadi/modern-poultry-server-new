const { ObjectId } = require("mongodb");

/**
 * Updates a payment account's balance and records an audit transaction entry.
 * Safely handles both standalone executions and caller-provided MongoDB sessions/transactions.
 */



async function updateAccountBalance({
  client,
  db,
  amount,
  transactionType,
  entrySource,
  accountId,
  details = {},
  session: externalSession = null
}) {
  const debugId = `BAL-${Date.now()}`;
  const session = externalSession || client.startSession();
  const isLocalSession = !externalSession;

  console.log(`\n========== [${debugId}] START updateAccountBalance ==========`);

  console.log(`[${debugId}] Input parameters:`, {
    amount,
    transactionType,
    entrySource,
    accountId: accountId?.toString(),
    details,
    hasExternalSession: Boolean(externalSession),
    isLocalSession
  });

  try {
    // 1. Start transaction if this function owns the session
    if (isLocalSession) {
      console.log(`[${debugId}] Starting local MongoDB transaction...`);
      await session.startTransaction();
      console.log(`[${debugId}] Local transaction started.`);
    } else {
      console.log(
        `[${debugId}] Using external session. Transaction is managed by caller.`
      );
    }

    // 2. Validate account ID
    if (!accountId) {
      console.error(`[${debugId}] VALIDATION FAILED: Account ID is missing.`);
      return { success: false, message: "Account ID is required" };
    }

    let accountObjectId;

    try {
      accountObjectId = new ObjectId(accountId);
    } catch (error) {
      console.error(`[${debugId}] INVALID ACCOUNT ID:`, accountId);
      return { success: false, message: "Invalid account ID format" };
    }

    console.log(`[${debugId}] Valid account ObjectId:`, accountObjectId.toString());

    // 3. Validate amount
    const numericAmount = Number(amount);

    console.log(`[${debugId}] Amount validation:`, {
      originalAmount: amount,
      numericAmount,
      isFinite: Number.isFinite(numericAmount)
    });

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      console.error(`[${debugId}] VALIDATION FAILED: Invalid amount.`);
      return { success: false, message: "Invalid transaction amount" };
    }

    const accountsCol = db.collection("payment_accounts");
    const transactionsCol = db.collection("transactions");

    // 4. Find account
    console.log(`[${debugId}] Searching payment_accounts...`, {
      _id: accountObjectId.toString()
    });

    const account = await accountsCol.findOne(
      { _id: accountObjectId },
      { session }
    );

    if (!account) {
      console.error(`[${debugId}] ACCOUNT NOT FOUND:`, accountObjectId.toString());
      return { success: false, message: "Payment account not found" };
    }

    console.log(`[${debugId}] Account found:`, {
      id: account._id.toString(),
      name: account.name,
      bank_name: account.bank_name,
      type: account.type,
      rawBalance: account.balance,
      balanceType: typeof account.balance
    });

    const previousBalance = Number(account.balance || 0);

    console.log(`[${debugId}] Previous balance:`, previousBalance);

    // 5. Calculate new balance
    let newBalance;

    if (transactionType === "credit") {
      newBalance = previousBalance + numericAmount;
      console.log(`[${debugId}] CREDIT:`, {
        previousBalance,
        amount: numericAmount,
        calculation: `${previousBalance} + ${numericAmount}`,
        newBalance
      });
    } else if (transactionType === "debit") {
      console.log(`[${debugId}] DEBIT:`, {
        previousBalance,
        amount: numericAmount,
        sufficientBalance: previousBalance >= numericAmount
      });

      if (previousBalance < numericAmount) {
        const message = `Insufficient balance in ${
          account.bank_name || account.name || "account"
        }`;

        console.error(`[${debugId}] BALANCE CHECK FAILED:`, {
          previousBalance,
          requestedDebit: numericAmount,
          shortfall: numericAmount - previousBalance,
          message
        });

        return { success: false, message };
      }

      newBalance = previousBalance - numericAmount;

      console.log(`[${debugId}] DEBIT calculation:`, {
        calculation: `${previousBalance} - ${numericAmount}`,
        newBalance
      });
    } else {
      console.error(`[${debugId}] INVALID TRANSACTION TYPE:`, transactionType);

      return {
        success: false,
        message: "Invalid transaction type (must be 'credit' or 'debit')"
      };
    }

    // 6. Update account balance
    console.log(`[${debugId}] Updating payment_accounts balance...`);

    const updateResult = await accountsCol.updateOne(
      { _id: account._id },
      {
        $set: {
          balance: newBalance,
          updatedAt: new Date()
        }
      },
      { session }
    );

    console.log(`[${debugId}] Account update result:`, {
      acknowledged: updateResult.acknowledged,
      matchedCount: updateResult.matchedCount,
      modifiedCount: updateResult.modifiedCount,
      intendedBalance: newBalance
    });

    if (updateResult.matchedCount !== 1) {
      throw new Error("Account balance update failed: account document not matched");
    }

    // 7. Insert transaction log
    const transactionDocument = {
      date: new Date(),
      time: new Date().toTimeString().split(" ")[0],
      account_id: account._id,
      account_type: account.type || "",
      entry_source: entrySource,
      transaction_type: transactionType,
      amount: numericAmount,
      balance_before_transaction: previousBalance,
      balance_after_transaction: newBalance,
      payment_details: details.paymentDetails || {},
      products: details.products || [],
      reference_id:
        details.invoiceId ||
        details.memoId ||
        details.saleId ||
        details.bill_id ||
        null,
      created_by: details.createdBy || "system",
      remarks: details.remarks || ""
    };

    console.log(`[${debugId}] Inserting transaction log:`, transactionDocument);

    const transactionResult = await transactionsCol.insertOne(
      transactionDocument,
      { session }
    );

    console.log(`[${debugId}] Transaction log insertion result:`, {
      acknowledged: transactionResult.acknowledged,
      insertedId: transactionResult.insertedId?.toString()
    });

    // 8. Commit only if this function owns the transaction
    if (isLocalSession) {
      console.log(`[${debugId}] Committing local transaction...`);
      await session.commitTransaction();
      console.log(`[${debugId}] Local transaction committed successfully.`);
    } else {
      console.log(
        `[${debugId}] No commit performed here. Caller must commit the transaction.`
      );
    }

    console.log(`[${debugId}] SUCCESS:`, {
      accountId: account._id.toString(),
      previousBalance,
      transactionType,
      amount: numericAmount,
      newBalance
    });

    console.log(`========== [${debugId}] END SUCCESS ==========\n`);

    return {
      success: true,
      message: "Account balance updated successfully",
      balance: newBalance
    };

  } catch (error) {
    console.error(`[${debugId}] ERROR:`, {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack
    });

    if (isLocalSession) {
      try {
        console.log(`[${debugId}] Aborting local transaction...`);
        await session.abortTransaction();
        console.log(`[${debugId}] Local transaction aborted.`);
      } catch (abortError) {
        console.error(`[${debugId}] Transaction abort failed:`, abortError.message);
      }
    } else {
      console.warn(
        `[${debugId}] External transaction was not aborted here. Caller must abort it.`
      );
    }

    console.log(`========== [${debugId}] END FAILURE ==========\n`);

    return {
      success: false,
      message: error.message || "Account balance update failed"
    };

  } finally {
    if (isLocalSession) {
      try {
        await session.endSession();
        console.log(`[${debugId}] Local session ended.`);
      } catch (sessionError) {
        console.error(`[${debugId}] Session cleanup failed:`, sessionError.message);
      }
    }
  }
}

module.exports = { updateAccountBalance };





// async function updateAccountBalance({
//   client,
//   db,
//   amount,
//   transactionType, // "credit" (inflow/income) | "debit" (outflow/expense)
//   entrySource,     // "sale" | "purchase" | "bill_create" | "customer_due_payment" | etc.
//   accountId,
//   details = {},
//   session: externalSession = null
// }) {
//   // Use caller session if supplied (e.g. inside an outer transaction), else spawn a local one
//   const session = externalSession || client.startSession();
//   const isLocalSession = !externalSession;

//   try {
//     if (isLocalSession) {
//       await session.startTransaction();
//     }

//     /* -----------------------
//        VALIDATIONS
//     ----------------------- */
//     if (!accountId) {
//       return { success: false, message: "Account ID is required" };
//     }

//     const numericAmount = Number(amount);
//     if (!numericAmount || numericAmount <= 0) {
//       return { success: false, message: "Invalid transaction amount" };
//     }

//     const accountsCol = db.collection("payment_accounts");
//     const transactionsCol = db.collection("transactions");

//     const account = await accountsCol.findOne(
//       { _id: new ObjectId(accountId) },
//       { session }
//     );

//     if (!account) {
//       return { success: false, message: "Payment account not found" };
//     }

//     const previousBalance = Number(account.balance || 0);

//     /* -----------------------
//        BALANCE CALCULATION
//     ----------------------- */
//     let newBalance;
//     if (transactionType === "credit") {
//       newBalance = previousBalance + numericAmount;
//     } else if (transactionType === "debit") {
//       if (previousBalance < numericAmount) {
//         return { success: false, message: `Insufficient balance in ${account.bank_name || account.name || "account"}` };
//       }
//       newBalance = previousBalance - numericAmount;
//     } else {
//       return { success: false, message: "Invalid transaction type (must be 'credit' or 'debit')" };
//     }

//     /* -----------------------
//        ATOMIC ACCOUNT UPDATE
//     ----------------------- */
//     await accountsCol.updateOne(
//       { _id: account._id },
//       { 
//         $set: { 
//           balance: newBalance,
//           updatedAt: new Date()
//         } 
//       },
//       { session }
//     );

//     /* -----------------------
//        TRANSACTION LOG
//     ----------------------- */
//     await transactionsCol.insertOne(
//       {
//         date: new Date(),
//         time: new Date().toTimeString().split(" ")[0],
//         account_id: account._id,
//         account_type: account.type || "",
//         entry_source: entrySource,
//         transaction_type: transactionType,
//         amount: numericAmount,
//         balance_before_transaction: previousBalance,
//         balance_after_transaction: newBalance,
//         payment_details: details.paymentDetails || {},
//         products: details.products || [],
//         reference_id: details.invoiceId || details.memoId || details.saleId || details.bill_id || null,
//         created_by: details.createdBy || "system",
//         remarks: details.remarks || ""
//       },
//       { session }
//     );

//     if (isLocalSession) {
//       await session.commitTransaction();
//     }

//     return {
//       success: true,
//       message: "Account balance updated successfully",
//       balance: newBalance
//     };

//   } catch (error) {
//     if (isLocalSession) {
//       await session.abortTransaction();
//     }
//     console.error("Account balance update failed:", error.message);
//     return {
//       success: false,
//       message: error.message || "Account balance update failed"
//     };
//   } finally {
//     if (isLocalSession) {
//       await session.endSession();
//     }
//   }
// }

// module.exports = { updateAccountBalance };



// how to use

// import { updateAccountBalance } from "../services/accountBalance.service.js";

// export async function createSale(req, res) {
//   try {
//     const { paid_amount, account_id, memoNo } = req.body;

    // if (paid_amount > 0) {
    //   await updateAccountBalance({
    //     client,
    //     db,
    //     amount: paid_amount,
    //     transactionType: "debit",
    //     entrySource: "purchase",
    //     accountId: account_id,
    //     details: {
    //       invoiceId: invoice_id,
    //       paymentMethod: payment_method,
    //     },
    //   });
    // }

//     res.status(201).json({ success: true });

//   } catch (err) {
//     res.status(400).json({ success: false, message: err.message });
//   }
// }
