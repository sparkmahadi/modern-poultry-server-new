require("dotenv").config();
const { connectToDB, client } = require("../db");

async function run() {
  try {
    const db = await connectToDB();
    const result = await db.collection("users").updateMany(
      { "info.key.secret.pass": { $exists: true } },
      { $unset: { "info.key.secret.pass": "" } }
    );
    console.log(`Removed legacy plaintext password fields from ${result.modifiedCount} user record(s).`);
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error("Legacy password cleanup failed:", error.message);
  process.exitCode = 1;
});
