'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { getDb, saveDb } = require('./db');
const { splitHands } = require('./parser');
const { insertParsedHands, loadExistingIds } = require('./importer');

/**
 * Process a single hand history file: parse any hands not yet in the DB
 * and insert them.  Returns a result summary.
 *
 * Only hands whose text contains *** SUMMARY *** are imported — this guards
 * against PokerStars writing a hand incrementally mid-session; we only ever
 * store complete hands.
 */
async function processFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${path.basename(filePath)}: ${err.message}`);
  }

  const rawHands = splitHands(content).filter(h => h.includes('*** SUMMARY ***'));
  if (!rawHands.length) return { imported: 0, skipped: 0, errors: 0, errorDetails: [] };

  const db = await getDb();
  const existingIds = loadExistingIds(db);
  const result = insertParsedHands(db, rawHands, existingIds);
  if (result.imported > 0) saveDb();
  return result;
}

/**
 * Start a chokidar watcher on watchPath/*.txt.
 *
 * chokidar's awaitWriteFinish option holds the event until the file size
 * hasn't changed for stabilityThreshold ms — this naturally handles
 * PokerStars writing hands incrementally during a session.
 *
 * @param {string}   watchPath       - directory to watch
 * @param {function} onNewHands      - optional callback({ file, imported, skipped, errors })
 * @returns {import('chokidar').FSWatcher}
 */
function startWatcher(watchPath, onNewHands) {
  if (!fs.existsSync(watchPath)) {
    console.warn(`[watcher] Directory not found, watcher disabled: ${watchPath}`);
    return null;
  }

  const watcher = chokidar.watch(path.join(watchPath, '*.txt'), {
    persistent: true,
    // Don't re-fire for files that existed before the server started.
    // The startup import already handles those.
    ignoreInitial: true,
    awaitWriteFinish: {
      // Wait until the file is stable for 500 ms before firing.
      // PokerStars flushes each action to disk, so this prevents us from
      // trying to parse a hand that's still being written.
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const handleFile = async (filePath, event) => {
    const label = `[watcher] ${event} ${path.basename(filePath)}`;
    try {
      const result = await processFile(filePath);
      if (result.imported > 0) {
        console.log(`${label}: +${result.imported} hand(s) imported`);
        if (onNewHands) onNewHands({ file: path.basename(filePath), ...result });
      } else if (result.errors > 0) {
        console.warn(`${label}: ${result.errors} parse error(s)`);
      }
      // Silently skip when imported=0 and errors=0 (all hands already in DB)
    } catch (err) {
      console.error(`${label}: ${err.message}`);
    }
  };

  watcher
    .on('add',    filePath => handleFile(filePath, 'new file'))
    .on('change', filePath => handleFile(filePath, 'changed'))
    .on('error',  err      => console.error('[watcher] error:', err))
    .on('ready',  ()       => console.log(`[watcher] Watching ${watchPath}`));

  return watcher;
}

module.exports = { startWatcher, processFile };
