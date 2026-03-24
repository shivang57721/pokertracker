'use strict';

/**
 * Adds missing 'uncalled_return' actions for hands that were imported before
 * the parser was updated to record them.
 *
 * Safe to run multiple times — it skips any hand that already has at least
 * one uncalled_return action in the database.
 *
 * Run directly:  node src/reparse-uncalled.js
 * Or via API:    POST /api/reparse-uncalled
 */

const { getDb, saveDb, queryAll } = require('./db');

// Parse "Uncalled bet ($X) returned to Player" lines from raw hand text
function extractUncalledReturns(rawText) {
  const returns = [];
  for (const line of rawText.split('\n')) {
    const m = line.trim().match(/^Uncalled bet \(\$?([\d.]+)\) returned to (.+)$/);
    if (m) returns.push({ player: m[2].trim(), amount: parseFloat(m[1]) });
  }
  return returns;
}

async function reparseUncalled() {
  const db = await getDb();

  // Find hands that have no uncalled_return action yet
  const hands = queryAll(db, `
    SELECT h.hand_id, h.raw_text
    FROM hands h
    WHERE NOT EXISTS (
      SELECT 1 FROM hand_actions ha
      WHERE ha.hand_id = h.hand_id AND ha.action = 'uncalled_return'
    )
    ORDER BY h.hand_id
  `);

  const total = hands.length;
  console.log(`[reparse-uncalled] ${total} hands to check…`);

  let inserted = 0, skipped = 0, errors = 0;

  // Find the current max action_order per hand so we can append after it
  const stmt = db.prepare(`
    INSERT INTO hand_actions (hand_id, street, action_order, player, action, amount, total_amount, is_all_in)
    VALUES (?, 'river', ?, ?, 'uncalled_return', ?, NULL, 0)
  `);

  db.run('BEGIN TRANSACTION');
  try {
    for (const row of hands) {
      try {
        const returns = extractUncalledReturns(row.raw_text);
        if (!returns.length) { skipped++; continue; }

        // Find max action_order for this hand to append after existing actions
        const maxRow = db.exec(
          `SELECT COALESCE(MAX(action_order), 0) AS mx FROM hand_actions WHERE hand_id = '${row.hand_id.replace(/'/g, "''")}'`
        );
        let order = maxRow.length > 0 ? (maxRow[0].values[0][0] || 0) : 0;

        for (const r of returns) {
          order++;
          stmt.run([row.hand_id, order, r.player, r.amount]);
          inserted++;
        }
      } catch (err) {
        errors++;
        console.warn(`[reparse-uncalled] hand ${row.hand_id}: ${err.message}`);
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
  console.log(`[reparse-uncalled] done — ${inserted} records inserted, ${skipped} hands had no uncalled bets, ${errors} errors`);
  return { total, inserted, skipped, errors };
}

module.exports = { reparseUncalled };

if (require.main === module) {
  reparseUncalled()
    .then(r => {
      console.log(`Complete: ${r.inserted} uncalled_return actions inserted across ${r.total} hands checked`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
