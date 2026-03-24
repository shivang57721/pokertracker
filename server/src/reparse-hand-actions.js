'use strict';

/**
 * Replaces all hand_actions rows using the current parser.
 *
 * This fixes two historical data quality issues:
 *  1. Raise 'amount' was stored as the PokerStars increment (raise_by) instead
 *     of the actual chips put in (total_amount - prior_street_commitment).
 *  2. 'Uncalled bet' returns were not stored at all, so the returned portion
 *     of an uncontested raise was counted as invested.
 *
 * All other tables (hands, hand_players, hand_flags, ai_analysis, reviewed_hands)
 * are untouched.  Safe to run multiple times.
 *
 * Run directly:  node src/reparse-hand-actions.js
 * Or via API:    POST /api/reparse-hand-actions
 */

const { getDb, saveDb, queryAll } = require('./db');
const { parseHand } = require('./parser');

async function reparseHandActions() {
  const db = await getDb();

  const hands = queryAll(db, 'SELECT hand_id, raw_text FROM hands ORDER BY hand_id');
  const total = hands.length;
  console.log(`[reparse-hand-actions] ${total} hands to reprocess…`);

  let reparsed = 0, errors = 0;

  const stmtInsert = db.prepare(`
    INSERT INTO hand_actions
      (hand_id, street, action_order, player, action, amount, total_amount, is_all_in)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.run('BEGIN TRANSACTION');
  try {
    for (const row of hands) {
      try {
        const hand = parseHand(row.raw_text);
        if (!hand || !hand.hand_id) { errors++; continue; }

        // Replace all actions for this hand
        db.run('DELETE FROM hand_actions WHERE hand_id = ?', [row.hand_id]);

        for (const a of hand.actions) {
          stmtInsert.run([
            row.hand_id,
            a.street,
            a.action_order,
            a.player,
            a.action,
            a.amount ?? null,
            a.total_amount ?? null,
            a.is_all_in ? 1 : 0,
          ]);
        }

        reparsed++;
      } catch (err) {
        errors++;
        console.warn(`[reparse-hand-actions] hand ${row.hand_id}: ${err.message}`);
      }
    }

    stmtInsert.free();
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    stmtInsert.free();
    throw err;
  }

  saveDb();
  console.log(`[reparse-hand-actions] done — ${reparsed} hands reparsed, ${errors} errors`);
  return { total, reparsed, errors };
}

module.exports = { reparseHandActions };

if (require.main === module) {
  reparseHandActions()
    .then(r => {
      console.log(`Complete: ${r.reparsed}/${r.total} hands reparsed, ${r.errors} errors`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
