'use strict';

/**
 * Clears all hand_flags rows and re-runs the analyzer over every eligible hand.
 * Run directly: node src/reanalyze.js
 */

const { getDb, saveDb } = require('./db');
const { analyzeAllHands } = require('./analyzer');

async function reanalyze() {
  const db = await getDb();

  const before = db.exec('SELECT COUNT(*) AS n FROM hand_flags')[0]?.values[0][0] ?? 0;
  console.log(`[reanalyze] clearing ${before} existing flag rows…`);
  db.run('DELETE FROM hand_flags');
  saveDb();

  console.log('[reanalyze] running analyzer…');
  const result = await analyzeAllHands();
  console.log(`[reanalyze] done — analyzed ${result.analyzed}, flagged ${result.flagged}, skipped ${result.skipped}`);
  return result;
}

if (require.main === module) {
  reanalyze()
    .then(() => process.exit(0))
    .catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}

module.exports = { reanalyze };
