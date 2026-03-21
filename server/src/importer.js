'use strict';

const fs = require('fs');
const path = require('path');
const { getDb, saveDb } = require('./db');
const { parseHand, splitHands } = require('./parser');

const DEFAULT_HH_PATH = path.join(
  process.env.HOME || '',
  'Library/Application Support/PokerStarsCH/HandHistory/FlaminGalah12'
);

/**
 * Core insert logic — shared by the directory importer and the file watcher.
 *
 * Takes an already-open db, an array of raw hand strings, and the Set of
 * hand_ids already in the database.  Runs inside a single transaction.
 * Mutates existingIds to stay current for the caller's subsequent calls.
 *
 * @param {object}   db          - open sql.js Database
 * @param {string[]} rawHands    - individual hand text blocks
 * @param {Set}      existingIds - hand_ids already in DB (mutated in-place)
 * @returns {{ imported, skipped, errors, errorDetails }}
 */
function insertParsedHands(db, rawHands, existingIds) {
  let imported = 0, skipped = 0, errors = 0;
  const errorDetails = [];

  db.run('BEGIN TRANSACTION');
  try {
    const stmtHand = db.prepare(`
      INSERT INTO hands
        (hand_id, tournament_id, is_tournament, game_type, stakes, small_blind, big_blind,
         date_played, table_name, max_seats, button_seat, total_pot, rake, board, raw_text)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const stmtPlayer = db.prepare(`
      INSERT INTO hand_players
        (hand_id, seat, player, starting_chips, position, hole_cards, amount_won, did_muck)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    const stmtAction = db.prepare(`
      INSERT INTO hand_actions
        (hand_id, street, action_order, player, action, amount, total_amount, is_all_in)
      VALUES (?,?,?,?,?,?,?,?)
    `);

    for (const rawHand of rawHands) {
      try {
        const hand = parseHand(rawHand);
        if (!hand || !hand.hand_id) { errors++; continue; }

        if (existingIds.has(hand.hand_id)) { skipped++; continue; }

        stmtHand.run([
          hand.hand_id,
          hand.tournament_id ?? null,
          hand.is_tournament ? 1 : 0,
          hand.game_type ?? null,
          hand.stakes ?? null,
          hand.small_blind ?? null,
          hand.big_blind ?? null,
          hand.date_played ?? null,
          hand.table_name ?? null,
          hand.max_seats ?? null,
          hand.button_seat ?? null,
          hand.total_pot ?? null,
          hand.rake ?? null,
          JSON.stringify(hand.board),
          hand.raw_text,
        ]);

        for (const p of hand.players) {
          stmtPlayer.run([
            hand.hand_id, p.seat, p.player, p.starting_chips ?? null,
            p.position ?? null, JSON.stringify(p.hole_cards),
            p.amount_won ?? 0, p.did_muck ? 1 : 0,
          ]);
        }

        for (const a of hand.actions) {
          stmtAction.run([
            hand.hand_id, a.street, a.action_order, a.player, a.action,
            a.amount ?? null, a.total_amount ?? null, a.is_all_in ? 1 : 0,
          ]);
        }

        existingIds.add(hand.hand_id);
        imported++;
      } catch (err) {
        errors++;
        errorDetails.push({
          context: rawHand.split('\n')[0].substring(0, 80),
          error: err.message,
        });
      }
    }

    stmtHand.free();
    stmtPlayer.free();
    stmtAction.free();

    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }

  return { imported, skipped, errors, errorDetails };
}

/**
 * Load all hand_ids currently in the database into a Set.
 */
function loadExistingIds(db) {
  const result = db.exec('SELECT hand_id FROM hands');
  return new Set(result.length > 0 ? result[0].values.map(r => r[0]) : []);
}

/**
 * Import all .txt hand history files from a directory.
 * Skips hands already in the database (by hand_id).
 */
async function importFromDirectory(dirPath = DEFAULT_HH_PATH) {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Hand history directory not found: ${dirPath}`);
  }

  const db = await getDb();
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt')).sort();
  const existingIds = loadExistingIds(db);

  let totalImported = 0, totalSkipped = 0, totalErrors = 0;
  const allErrorDetails = [];

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      totalErrors++;
      allErrorDetails.push({ file, error: e.message });
      continue;
    }

    // Only import complete hands (ones that have reached the SUMMARY section)
    const rawHands = splitHands(content).filter(h => h.includes('*** SUMMARY ***'));
    if (!rawHands.length) continue;

    const result = insertParsedHands(db, rawHands, existingIds);
    totalImported += result.imported;
    totalSkipped  += result.skipped;
    totalErrors   += result.errors;
    allErrorDetails.push(...result.errorDetails);
  }

  saveDb();
  return {
    imported: totalImported,
    skipped:  totalSkipped,
    errors:   totalErrors,
    files:    files.length,
    errorDetails: allErrorDetails.slice(0, 20),
  };
}

module.exports = { importFromDirectory, insertParsedHands, loadExistingIds, DEFAULT_HH_PATH };

// Allow running directly: node src/importer.js
if (require.main === module) {
  importFromDirectory()
    .then(r => {
      console.log(`Import complete: ${r.imported} new, ${r.skipped} skipped, ${r.errors} errors across ${r.files} files`);
      if (r.errorDetails.length) console.log('Errors:', JSON.stringify(r.errorDetails, null, 2));
    })
    .catch(err => { console.error('Import failed:', err.message); process.exit(1); });
}
