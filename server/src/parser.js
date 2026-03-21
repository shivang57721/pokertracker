'use strict';

/**
 * PokerStars hand history parser.
 * Handles: cash games, tournaments, all-in/side pots, showdowns, mucks.
 */

// Position names indexed from BTN (index 0), going clockwise around the table.
// Sequence: BTN → SB → BB → UTG → … → CO → (back to BTN)
// This matches the preflop action order when reversed: UTG … CO BTN SB BB.
const POSITION_NAMES = {
  2: ['button',      'big blind'],
  3: ['button',      'small blind', 'big blind'],
  4: ['button',      'small blind', 'big blind', 'co'],
  5: ['button',      'small blind', 'big blind', 'utg',   'co'],
  6: ['button',      'small blind', 'big blind', 'utg',   'hj',    'co'],
  7: ['button',      'small blind', 'big blind', 'utg',   'utg+1', 'hj',  'co'],
  8: ['button',      'small blind', 'big blind', 'utg',   'utg+1', 'mp',  'hj',  'co'],
  9: ['button',      'small blind', 'big blind', 'utg',   'utg+1', 'mp',  'lj',  'hj', 'co'],
};

/**
 * Assign positions to all active players in a hand.
 *
 * "Active" = any player who has at least one recorded action or was dealt
 * hole cards.  Players who are seated but sitting out have no actions and
 * are excluded from the positional calculation.
 *
 * Seats are numbered clockwise on PokerStars tables, so sorting them
 * ascending and rotating around the button gives the correct clockwise order.
 *
 * @param {object[]} players    - hand.players array (mutated in-place)
 * @param {object[]} actions    - hand.actions array (read-only)
 * @param {number}   buttonSeat - seat number of the dealer button
 */
function assignPositions(players, actions, buttonSeat) {
  if (!buttonSeat || !players.length) return;

  // Build the set of seats belonging to active players
  const nameToSeat = new Map(players.map(p => [p.player, p.seat]));
  const activeSeatSet = new Set();

  for (const a of actions) {
    const seat = nameToSeat.get(a.player);
    if (seat != null) activeSeatSet.add(seat);
  }
  // Also include anyone dealt hole cards (in case they fold without an action)
  for (const p of players) {
    if (p.hole_cards.length > 0) activeSeatSet.add(p.seat);
  }

  const activeSeats = [...activeSeatSet].sort((a, b) => a - b); // clockwise order
  const n = activeSeats.length;
  const names = POSITION_NAMES[n];
  if (!names) return; // unsupported player count — leave positions as-is

  const btnIdx = activeSeats.indexOf(buttonSeat);
  if (btnIdx === -1) return; // button seat is not among active players

  // Assign clockwise starting from the button
  for (let i = 0; i < n; i++) {
    const seat   = activeSeats[(btnIdx + i) % n];
    const player = players.find(p => p.seat === seat);
    if (player) player.position = names[i];
  }
}

function parseCards(str) {
  if (!str) return [];
  return str.trim().split(/\s+/).filter(c => /^[2-9TJQKA][cdhs]$/.test(c));
}

function parseAmount(str) {
  if (str == null || str === '') return null;
  const n = parseFloat(str.toString().replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

function parseHeader(line, hand) {
  // Hand ID
  const handIdM = line.match(/Hand #(\d+)/);
  if (handIdM) hand.hand_id = handIdM[1];

  // Tournament
  const tournM = line.match(/Tournament #(\d+)/);
  if (tournM) {
    hand.tournament_id = tournM[1];
    hand.is_tournament = true;
  }

  // Game type — order matters: more specific first
  const gtM = line.match(
    /(Omaha Hi\/Lo(?:\s+(?:No Limit|Pot Limit|Limit))?|Omaha(?:\s+(?:No Limit|Pot Limit|Limit))?|Hold'em No Limit|Hold'em Pot Limit|Hold'em Limit|5 Card Draw|Badugi)/i
  );
  if (gtM) hand.game_type = gtM[1];

  if (hand.is_tournament) {
    // "Level III (25/50)" — blinds in chips
    const lvlM = line.match(/Level ([IVXLCDM]+)\s*\((\d+)\/(\d+)\)/);
    if (lvlM) {
      hand.stakes = `Level ${lvlM[1]} (${lvlM[2]}/${lvlM[3]})`;
      hand.small_blind = parseAmount(lvlM[2]);
      hand.big_blind = parseAmount(lvlM[3]);
    }
  } else {
    // "($0.02/$0.05 USD)" or "($1/$2)"
    const stkM = line.match(/\(\$?([\d.]+)\/\$?([\d.]+)\s*(?:USD|EUR|GBP|play chips)?\)/);
    if (stkM) {
      hand.stakes = `${stkM[1]}/${stkM[2]}`;
      hand.small_blind = parseAmount(stkM[1]);
      hand.big_blind = parseAmount(stkM[2]);
    }
  }

  // Date — first timestamp in the line (CET / server time)
  const dateM = line.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/);
  if (dateM) hand.date_played = dateM[1].replace(/\//g, '-');
}

function parseHand(rawText) {
  const lines = rawText.split('\n').map(l => l.trimEnd());
  if (!lines[0] || !lines[0].startsWith('PokerStars Hand #')) return null;

  const hand = {
    hand_id: null,
    tournament_id: null,
    is_tournament: false,
    game_type: null,
    stakes: null,
    small_blind: null,
    big_blind: null,
    date_played: null,
    table_name: null,
    max_seats: null,
    button_seat: null,
    total_pot: null,
    rake: null,
    board: [],        // string[] of cards e.g. ['2c','4s','3c','6s','5d']
    raw_text: rawText,
    players: [],      // { seat, player, starting_chips, position, hole_cards, amount_won, did_muck }
    actions: [],      // { street, action_order, player, action, amount, total_amount, is_all_in }
  };

  parseHeader(lines[0], hand);

  let street = 'preflop';
  const ord = { v: 0 };
  let inSummary = false;

  const addAction = (player, action, amount, totalAmount, isAllIn) => {
    hand.actions.push({
      street,
      action_order: ord.v++,
      player,
      action,
      amount: amount ?? null,
      total_amount: totalAmount ?? amount ?? null,
      is_all_in: isAllIn || false,
    });
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // ── SUMMARY ──────────────────────────────────────────────────────────────
    if (line === '*** SUMMARY ***') { inSummary = true; continue; }

    if (inSummary) {
      // Total pot $1.80 | Rake $0.09
      // Total pot 3620 Main pot 2940. Side pot 680. | Rake 0
      const potM = line.match(/Total pot \$?([\d.]+)/);
      if (potM) hand.total_pot = parseAmount(potM[1]);

      const rakeM = line.match(/\| Rake \$?([\d.]+)/);
      if (rakeM) hand.rake = parseAmount(rakeM[1]);

      if (line.startsWith('Board [')) {
        const bm = line.match(/\[([^\]]+)\]/);
        if (bm) hand.board = parseCards(bm[1]);
      }

      // Seat N: Player [(pos)] showed [Xx Yy] / mucked [Xx Yy] / folded / collected
      if (line.startsWith('Seat ')) {
        const seatNumM = line.match(/^Seat (\d+):/);
        if (seatNumM) {
          const p = hand.players.find(p => p.seat === parseInt(seatNumM[1]));
          if (p) {
            const posM = line.match(/\((button|small blind|big blind)\)/);
            if (posM) p.position = posM[1];

            const showedM = line.match(/showed \[([^\]]+)\]/);
            if (showedM && p.hole_cards.length === 0) p.hole_cards = parseCards(showedM[1]);

            const muckedM = line.match(/mucked \[([^\]]+)\]/);
            if (muckedM) {
              p.did_muck = true;
              if (p.hole_cards.length === 0) p.hole_cards = parseCards(muckedM[1]);
            }
          }
        }
      }
      continue;
    }

    // ── SECTION MARKERS ──────────────────────────────────────────────────────
    if (line === '*** HOLE CARDS ***') { street = 'preflop'; continue; }

    if (line.startsWith('*** FLOP ***')) {
      street = 'flop';
      const m = line.match(/\[([^\]]+)\]/);
      if (m) hand.board = parseCards(m[1]);
      continue;
    }
    if (line.startsWith('*** TURN ***')) {
      street = 'turn';
      const boards = [...line.matchAll(/\[([^\]]+)\]/g)];
      if (boards.length >= 2) hand.board = [...parseCards(boards[0][1]), ...parseCards(boards[1][1])];
      continue;
    }
    if (line.startsWith('*** RIVER ***')) {
      street = 'river';
      const boards = [...line.matchAll(/\[([^\]]+)\]/g)];
      if (boards.length >= 2) hand.board = [...parseCards(boards[0][1]), ...parseCards(boards[1][1])];
      continue;
    }
    if (line.startsWith('*** SHOW DOWN ***')) { street = 'showdown'; continue; }

    // ── TABLE ─────────────────────────────────────────────────────────────────
    if (line.startsWith("Table '")) {
      const m = line.match(/Table '([^']+)'\s+(\d+)-max\s+Seat #(\d+) is the button/);
      if (m) {
        hand.table_name = m[1];
        hand.max_seats = parseInt(m[2]);
        hand.button_seat = parseInt(m[3]);
      }
      continue;
    }

    // ── SEAT DEFINITIONS ──────────────────────────────────────────────────────
    // "Seat 2: PlayerName ($5.13 in chips)"
    // "Seat 1: PlayerName (1500 in chips) is sitting out"
    const seatDefM = line.match(/^Seat (\d+): (.+?) \(\$?([\d.]+) in chips\)(.*)?$/);
    if (seatDefM) {
      hand.players.push({
        seat: parseInt(seatDefM[1]),
        player: seatDefM[2].trim(),
        starting_chips: parseAmount(seatDefM[3]),
        position: null,
        hole_cards: [],
        amount_won: 0,
        did_muck: false,
      });
      continue;
    }

    // ── TABLE EVENT LINES (skip) ──────────────────────────────────────────────
    if (/^.+: (?:doesn't show hand|sits out)$/.test(line)) continue;
    if (/^.+ (?:joins the table|leaves the table|has returned|finished the tournament)/.test(line)) continue;
    if (line.startsWith('luiafelipees has returned')) continue; // defensive

    // ── DEALT TO (hero hole cards) ────────────────────────────────────────────
    const dealtM = line.match(/^Dealt to (.+?) \[([^\]]+)\]$/);
    if (dealtM) {
      const p = hand.players.find(p => p.player === dealtM[1]);
      if (p) p.hole_cards = parseCards(dealtM[2]);
      continue;
    }

    // ── SHOWDOWN REVEALS ──────────────────────────────────────────────────────
    const showsM = line.match(/^(.+?): shows \[([^\]]+)\]/);
    if (showsM) {
      const p = hand.players.find(p => p.player === showsM[1]);
      if (p && p.hole_cards.length === 0) p.hole_cards = parseCards(showsM[2]);
      continue;
    }
    const mucksM = line.match(/^(.+?): mucks hand$/);
    if (mucksM) {
      const p = hand.players.find(p => p.player === mucksM[1]);
      if (p) p.did_muck = true;
      continue;
    }

    // ── COLLECTED (pot wins) ──────────────────────────────────────────────────
    // "Player collected $0.85 from pot"
    // "Player collected 2940 from main pot"
    // "Player collected 680 from side pot"
    const collM = line.match(/^(.+?) collected \$?([\d.]+) from (?:main pot|side pot|pot)$/);
    if (collM) {
      const p = hand.players.find(p => p.player === collM[1]);
      if (p) p.amount_won += parseAmount(collM[2]);
      continue;
    }

    // "Uncalled bet ($X) returned to Player" — skip, not a betting action
    if (line.startsWith('Uncalled bet')) continue;

    // ── BLIND / ANTE POSTS ────────────────────────────────────────────────────
    const sbM = line.match(/^(.+?): posts small blind \$?([\d.]+)$/);
    if (sbM) {
      const p = hand.players.find(p => p.player === sbM[1]);
      if (p && !p.position) p.position = 'small blind';
      addAction(sbM[1], 'post_sb', parseAmount(sbM[2]), null, false);
      continue;
    }

    const bbM = line.match(/^(.+?): posts big blind \$?([\d.]+)( and is all-in)?$/);
    if (bbM) {
      const p = hand.players.find(p => p.player === bbM[1]);
      if (p && !p.position) p.position = 'big blind';
      addAction(bbM[1], 'post_bb', parseAmount(bbM[2]), null, !!bbM[3]);
      continue;
    }

    const anteM = line.match(/^(.+?): posts (?:the )?ante \$?([\d.]+)$/);
    if (anteM) {
      addAction(anteM[1], 'post_ante', parseAmount(anteM[2]), null, false);
      continue;
    }

    // ── BETTING ACTIONS ────────────────────────────────────────────────────────
    // Each pattern explicitly handles optional "and is all-in" suffix.

    const foldM = line.match(/^(.+?): folds$/);
    if (foldM) { addAction(foldM[1], 'fold', null, null, false); continue; }

    const checkM = line.match(/^(.+?): checks$/);
    if (checkM) { addAction(checkM[1], 'check', null, null, false); continue; }

    // "calls $0.07" or "calls $0.07 and is all-in"
    const callM = line.match(/^(.+?): calls \$?([\d.]+)( and is all-in)?$/);
    if (callM) {
      addAction(callM[1], 'call', parseAmount(callM[2]), null, !!callM[3]);
      continue;
    }

    // "bets $0.18" or "bets 240 and is all-in"
    const betM = line.match(/^(.+?): bets \$?([\d.]+)( and is all-in)?$/);
    if (betM) {
      addAction(betM[1], 'bet', parseAmount(betM[2]), null, !!betM[3]);
      continue;
    }

    // "raises $0.07 to $0.12" or "raises 630 to 870 and is all-in"
    const raiseM = line.match(/^(.+?): raises \$?([\d.]+) to \$?([\d.]+)( and is all-in)?$/);
    if (raiseM) {
      addAction(raiseM[1], 'raise', parseAmount(raiseM[2]), parseAmount(raiseM[3]), !!raiseM[4]);
      continue;
    }
  }

  // Assign all positions (BTN, SB, BB, UTG, HJ, CO, …) from seat layout
  assignPositions(hand.players, hand.actions, hand.button_seat);

  return hand;
}

/**
 * Split a hand history file into individual hand strings.
 * Hands start with "PokerStars Hand #" and are separated by blank lines.
 */
function splitHands(content) {
  return content
    .split(/(?=PokerStars Hand #)/)
    .map(h => h.trim())
    .filter(h => h.startsWith('PokerStars Hand #') && h.length > 100);
}

module.exports = { parseHand, splitHands, parseCards, parseAmount };
