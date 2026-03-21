'use strict';

/**
 * Re-parses every hand in the database using the updated parser and
 * writes the corrected position values back into hand_players.position.
 *
 * Only the position column is touched — all other data is left as-is.
 *
 * Run directly:  node src/reparse-positions.js
 * Or via API:    POST /api/reparse-positions
 */

const { getDb, saveDb, queryAll } = require('./db');
const { parseHand } = require('./parser');

async function reparsePositions() {
  const db = await getDb();

  const hands = queryAll(db, 'SELECT hand_id, raw_text FROM hands ORDER BY hand_id');
  const total = hands.length;
  console.log(`[reparse-positions] ${total} hands to process…`);

  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  const stmt = db.prepare(
    'UPDATE hand_players SET position = ? WHERE hand_id = ? AND player = ?'
  );

  db.run('BEGIN TRANSACTION');
  try {
    for (const row of hands) {
      try {
        const hand = parseHand(row.raw_text);
        if (!hand || !hand.hand_id) { skipped++; continue; }

        for (const p of hand.players) {
          stmt.run([p.position ?? null, row.hand_id, p.player]);
        }
        updated++;
      } catch (err) {
        errors++;
        // Don't abort the whole run for one bad hand
        console.warn(`[reparse-positions] hand ${row.hand_id}: ${err.message}`);
      }
    }

    stmt.free();
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    stmt.free();
    throw err;
  }

  saveDb();
  console.log(`[reparse-positions] done — ${updated} updated, ${skipped} skipped, ${errors} errors`);
  return { total, updated, skipped, errors };
}

module.exports = { reparsePositions };

// Allow running directly: node src/reparse-positions.js
if (require.main === module) {
  reparsePositions()
    .then(r => {
      console.log(`Complete: ${r.updated}/${r.total} hands updated, ${r.errors} errors`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
