'use strict';

const { getDb, saveDb, queryAll, queryOne } = require('./db');
const {
  RANK_IDX,
  classifyHand,
  RFI_RANGES,
  BB_DEFENCE_RANGES,
  hasFlushDraw,
  hasMadeFlush,
  getStraightDrawType,
  hasMadeStraight,
  isDryBoard,
  evaluateHandStrength,
  getDrawEquity,
} = require('./handEvaluator');

const HERO = 'FlaminGalah12';

// Postflop position order: higher = acts later = in position
const POSITION_ORDER = {
  'small blind': 0, 'big blind': 1,
  'utg': 2, 'utg+1': 3, 'mp': 4, 'lj': 5, 'hj': 6, 'co': 7, 'button': 8,
};

// DB position → RFI range key
const POS_TO_RANGE = {
  'button': 'btn', 'small blind': 'sb', 'big blind': 'bb',
  'utg': 'utg', 'utg+1': 'utg', 'mp': 'utg',
  'lj': 'hj', 'hj': 'hj', 'co': 'co',
};

function isPost(action) {
  return action === 'post_sb' || action === 'post_bb' || action === 'post_ante';
}

// Sum all action amounts before targetOrder
function potBefore(allActions, targetOrder) {
  let pot = 0;
  for (const a of allActions) {
    if (a.action_order >= targetOrder) break;
    pot += (a.amount || 0);
  }
  return pot;
}

// Sum all action amounts in streets that come before `street`
function potAtStreetStart(allActions, street) {
  const ORDER = { preflop: 0, flop: 1, turn: 2, river: 3, showdown: 4 };
  const limit = ORDER[street] ?? 99;
  return allActions
    .filter(a => (ORDER[a.street] ?? 0) < limit)
    .reduce((s, a) => s + (a.amount || 0), 0);
}

// Hero's first voluntary preflop action context
function preflopCtx(preflopActions) {
  const idx = preflopActions.findIndex(a => a.player === HERO && !isPost(a.action));
  if (idx === -1) return null;
  const heroAction       = preflopActions[idx];
  const voluntaryBefore  = preflopActions.slice(0, idx).filter(a => !isPost(a.action));
  const raisesBefore     = voluntaryBefore.filter(a => a.action === 'raise');
  return { heroAction, voluntaryBefore, raisesBefore, heroIdx: idx };
}

// Last player to raise preflop
function preflopAggressor(preflopActions) {
  let last = null;
  for (const a of preflopActions) if (a.action === 'raise') last = a.player;
  return last;
}

// ── Position-aware 3-bet evaluation ───────────────────────────────────────────
function evaluateThreeBet(handClass, heroPos, openerPos) {
  // Always-OK hands regardless of opener position
  const ALWAYS_OK = new Set([
    'QQ','KK','AA',
    'JJ','TT','99',
    'AKs','AKo','AQs','AQo','AJs',
    'A2s','A3s','A4s','A5s',
    '76s','87s','98s','T9s',
    '86s','97s','T8s','J9s',
  ]);

  // vs CO: add 88, Axs broadways, suited broadways, AJo, 65s
  const OK_VS_CO = new Set([
    ...ALWAYS_OK,
    '88',
    'ATs','A9s','A8s','A7s','A6s',
    'KQs','KJs','QJs',
    'AJo',
    '65s',
  ]);

  // vs BTN: widest — add 77, more suited broadways, KQo, lower suited connectors
  const OK_VS_BTN = new Set([
    ...OK_VS_CO,
    '77',
    'KTs','QTs','JTs',
    'KQo',
    '54s','64s','75s',
  ]);

  // vs SB: very wide — add ATo, KJo, K9s
  const OK_VS_SB = new Set([
    ...OK_VS_BTN,
    'ATo',
    'KJo',
    'K9s',
  ]);

  const norm = (openerPos || '').toLowerCase();
  let okSet;
  if      (norm === 'button')      okSet = OK_VS_BTN;
  else if (norm === 'co')          okSet = OK_VS_CO;
  else if (norm === 'small blind') okSet = OK_VS_SB;
  else                             okSet = ALWAYS_OK; // utg, utg+1, mp, lj, hj, or unknown

  if (okSet.has(handClass)) return null;

  const isPair    = handClass.length === 2 && handClass[0] === handClass[1];
  const isSuited  = handClass.endsWith('s');
  const isOffsuit = handClass.endsWith('o');
  const r1 = RANK_IDX[handClass[0]] ?? -1;
  const r2 = RANK_IDX[handClass[1]] ?? -1;
  const hiR = Math.max(r1, r2);
  const loR = Math.min(r1, r2);
  const JACK = RANK_IDX['J'];
  const TEN  = RANK_IDX['T'];

  const heroPosLabel   = heroPos || '?';
  const openerPosLabel = norm    || '?';

  let severity, reason;

  if (isPair) {
    severity = r1 <= RANK_IDX['6'] ? 2 : 1;
    reason   = r1 <= RANK_IDX['6']
      ? `${handClass} is too small for a 3-bet — small pairs play better as cold-calls or folds`
      : `${handClass} is marginal for a 3-bet vs a ${openerPosLabel} open`;
  } else if (isOffsuit) {
    if (hiR < JACK) {
      severity = 2;
      reason   = `${handClass} is offsuit below broadway — poor 3-bet with no blocker value`;
    } else if (loR <= TEN) {
      severity = 2;
      reason   = `${handClass} has a weak kicker for a 3-bet — consider fold or cold-call vs ${openerPosLabel}`;
    } else {
      severity = 1;
      reason   = `${handClass} is borderline for a 3-bet vs a ${openerPosLabel} open`;
    }
  } else if (isSuited) {
    const gap = hiR - loR;
    severity = (hiR < TEN && gap > 2) ? 2 : 1;
    reason   = (hiR < TEN && gap > 2)
      ? `${handClass} is low and disconnected — poor 3-bet bluff with minimal equity`
      : `${handClass} is outside recommended 3-bet bluff range vs a ${openerPosLabel} open`;
  } else {
    severity = 1;
    reason   = `${handClass} is outside recommended 3-bet range`;
  }

  return {
    severity,
    description: `3-bet ${handClass} from ${heroPosLabel} vs ${openerPosLabel} open — ${reason}`,
  };
}

// ── Core per-hand analysis ─────────────────────────────────────────────────────
function analyzeHand(hand, hero, allPlayers, allActions) {
  const flags = [];

  const holeCards = JSON.parse(hero.hole_cards || '[]');
  if (holeCards.length !== 2) return flags;

  const board      = JSON.parse(hand.board || '[]');
  const bigBlind   = hand.big_blind || 1;
  const heroPos    = (hero.position || '').toLowerCase();
  const handClass  = classifyHand(holeCards);
  if (!handClass) return flags;

  const preflop = allActions.filter(a => a.street === 'preflop');
  const flop    = allActions.filter(a => a.street === 'flop');
  const turn    = allActions.filter(a => a.street === 'turn');
  const river   = allActions.filter(a => a.street === 'river');

  const heroDidFold       = allActions.some(a => a.player === HERO && a.action === 'fold');
  // A real showdown requires an opponent to have shown cards — not just hero surviving to river
  const handHadShowdown   = allPlayers.some(p =>
    p.player !== HERO && JSON.parse(p.hole_cards || '[]').length > 0
  );
  const heroWentToShowdown = !heroDidFold && handHadShowdown;

  const ctx = preflopCtx(preflop);

  // ── Flag 1: Open too loose ─────────────────────────────────────────────────
  if (ctx) {
    const { heroAction, voluntaryBefore } = ctx;
    if (heroAction.action === 'raise' && voluntaryBefore.length === 0) {
      const key = POS_TO_RANGE[heroPos];
      if (key && key !== 'bb' && RFI_RANGES[key] && !RFI_RANGES[key].has(handClass)) {
        flags.push({
          flag_type: 'open_too_loose',
          street: 'preflop',
          severity: 2,
          description: `Opened ${handClass} from ${heroPos || '?'} — outside GTO RFI range for that position`,
        });
      }
    }
  }

  // ── Flag 1b: Open too tight ────────────────────────────────────────────────
  if (ctx) {
    const { heroAction, voluntaryBefore } = ctx;
    if (heroAction.action === 'fold' && voluntaryBefore.length === 0) {
      const key = POS_TO_RANGE[heroPos];
      if (key && key !== 'bb' && RFI_RANGES[key] && RFI_RANGES[key].has(handClass)) {
        flags.push({
          flag_type: 'open_too_tight',
          street: 'preflop',
          severity: 1,
          description: `Folded ${handClass} from ${heroPos || '?'} — this hand is in the GTO open range`,
        });
      }
    }
  }

  // ── Flag 2: Open limp ──────────────────────────────────────────────────────
  if (ctx) {
    const { heroAction, voluntaryBefore } = ctx;
    if (heroAction.action === 'call' && voluntaryBefore.length === 0) {
      let flag = true;
      if (heroPos === 'big blind')  flag = false;
      if (heroPos === 'small blind') flag = RFI_RANGES.sb ? !RFI_RANGES.sb.has(handClass) : true;
      if (flag) {
        flags.push({
          flag_type: 'open_limp',
          street: 'preflop',
          severity: 2,
          description: `Limped ${handClass} from ${heroPos || '?'} — open limping is a common leak in 6-max`,
        });
      }
    }
  }

  // ── Flag 3: Cold call instead of 3-bet or fold ────────────────────────────
  if (ctx && heroPos !== 'big blind') {
    const { heroAction, raisesBefore } = ctx;
    if (heroAction.action === 'call' && raisesBefore.length > 0) {
      flags.push({
        flag_type: 'cold_call',
        street: 'preflop',
        severity: 1,
        description: `Cold-called a raise with ${handClass} from ${heroPos || '?'} — solver prefers 3-bet or fold`,
      });
    }
  }

  // ── Flag 3b: BB defence too loose ─────────────────────────────────────────
  if (heroPos === 'big blind' && ctx) {
    const { heroAction, raisesBefore } = ctx;
    if (heroAction.action === 'call' && raisesBefore.length === 1) {
      const openerAction = raisesBefore[0];
      const openerRecord = allPlayers.find(p => p.player === openerAction.player);
      const openerPos    = openerRecord ? (openerRecord.position || '').toLowerCase() : null;
      const rangeKey     = POS_TO_RANGE[openerPos];
      if (rangeKey && BB_DEFENCE_RANGES[rangeKey] && !BB_DEFENCE_RANGES[rangeKey].has(handClass)) {
        flags.push({
          flag_type: 'bb_defence_too_loose',
          street: 'preflop',
          severity: 1,
          description: `Called a ${openerPos || '?'} open from BB with ${handClass} — outside GTO BB defence range`,
        });
      }
    }
  }

  // ── Flag 4: 3-bet too light (position-aware) ──────────────────────────────
  if (ctx) {
    const { heroAction, raisesBefore } = ctx;
    if (heroAction.action === 'raise' && raisesBefore.length > 0) {
      const openerAction = raisesBefore[raisesBefore.length - 1];
      const openerRecord = allPlayers.find(p => p.player === openerAction.player);
      const openerPos    = openerRecord ? (openerRecord.position || '').toLowerCase() : null;
      const result = evaluateThreeBet(handClass, heroPos, openerPos);
      if (result) {
        flags.push({
          flag_type: 'three_bet_too_light',
          street: 'preflop',
          severity: result.severity,
          description: result.description,
        });
      }
    }
  }

  // ── Flag 5: Folded too strong to a 3-bet ──────────────────────────────────
  if (ctx) {
    const { heroAction, voluntaryBefore, heroIdx } = ctx;
    if (heroAction.action === 'raise' && voluntaryBefore.length === 0) {
      const threeBetAction = preflop.find((a, i) =>
        i > heroIdx && a.player !== HERO && a.action === 'raise'
      );
      if (threeBetAction) {
        const threeBetIdx = preflop.indexOf(threeBetAction);
        const heroFolded  = preflop.find((a, i) =>
          i > threeBetIdx && a.player === HERO && a.action === 'fold'
        );
        if (heroFolded) {
          const SEV3 = new Set(['QQ', 'KK', 'AA', 'AKs']);
          const SEV2 = new Set(['JJ', 'QQ', 'KK', 'AA', 'AKs', 'AKo']);
          if (SEV2.has(handClass)) {
            flags.push({
              flag_type: 'fold_too_strong_3bet',
              street: 'preflop',
              severity: SEV3.has(handClass) ? 3 : 2,
              description: `Folded ${handClass} to a 3-bet — this hand is too strong to fold 100BB deep`,
            });
          }
        }
      }
    }
  }

  // ── Postflop setup ─────────────────────────────────────────────────────────
  if (board.length < 3) return flags;

  const flopCards   = board.slice(0, 3);
  const flopPlayers = new Set(flop.map(a => a.player));
  const isHU        = flopPlayers.size === 2 && flopPlayers.has(HERO);
  const heroPFR     = preflopAggressor(preflop) === HERO;

  const opponentName   = isHU ? [...flopPlayers].find(p => p !== HERO) : null;
  const opponentRecord = opponentName ? allPlayers.find(p => p.player === opponentName) : null;
  const opponentPos    = opponentRecord ? (opponentRecord.position || '').toLowerCase() : null;

  const heroPosFactor = POSITION_ORDER[heroPos] ?? -1;
  const oppPosFactor  = POSITION_ORDER[opponentPos] ?? -1;
  const heroIsIP      = heroPosFactor > oppPosFactor;
  const heroIsOOP     = heroPosFactor < oppPosFactor;

  const heroFlopAct  = flop.find(a => a.player === HERO);
  const heroRiverAct = river.find(a => a.player === HERO);

  // ── Flag 6: Missed c-bet (hero IP) ────────────────────────────────────────
  if (heroPFR && isHU && heroIsIP && heroFlopAct?.action === 'check') {
    const dry = isDryBoard(flopCards);
    flags.push({
      flag_type: 'missed_cbet_ip',
      street: 'flop',
      severity: dry ? 2 : 1,
      description: `PFR checked back ${flopCards.join(' ')} in position HU — missed c-bet${dry ? ' (dry board, higher frequency spot)' : ''}`,
    });
  }

  // ── Flag 7: Missed c-bet (hero OOP, dry board only) ───────────────────────
  if (heroPFR && isHU && heroIsOOP && heroFlopAct?.action === 'check' && isDryBoard(flopCards)) {
    flags.push({
      flag_type: 'missed_cbet_oop',
      street: 'flop',
      severity: 1,
      description: `PFR checked ${flopCards.join(' ')} OOP HU on a dry board — GTO c-bets at high frequency here`,
    });
  }

  // ── Flag 8: Folded a draw with good pot odds ───────────────────────────────
  for (const [street, streetActions, boardSlice] of [
    ['flop', flop, board.slice(0, 3)],
    ['turn', turn, board.slice(0, 4)],
  ]) {
    if (!streetActions.length) continue;
    const heroAct = streetActions.find(a => a.player === HERO);
    if (!heroAct || heroAct.action !== 'fold') continue;

    const drawEquity = getDrawEquity(holeCards, boardSlice, street);
    if (drawEquity == null) continue;

    // Find the last bet/raise before hero's fold
    let running   = potAtStreetStart(allActions, street);
    let lastBet   = 0;
    let potAtBet  = 0;
    for (const a of streetActions) {
      if (a.player === HERO && a.action === 'fold') break;
      if (a.action === 'bet' || a.action === 'raise') { potAtBet = running; lastBet = a.amount || 0; }
      running += (a.amount || 0);
    }
    if (lastBet <= 0) continue;

    const amtToCall = lastBet;
    const potOdds   = amtToCall / (potAtBet + lastBet + amtToCall);
    if (potOdds < drawEquity) {
      const drawType = hasFlushDraw(holeCards, boardSlice) ? 'flush draw'
        : getStraightDrawType(holeCards, boardSlice) === 'oesd' ? 'OESD' : 'gutshot';
      flags.push({
        flag_type: 'fold_draw_good_odds',
        street,
        severity: 2,
        description: `Folded ${drawType} (${handClass}) getting ${(potOdds * 100).toFixed(0)}% pot odds vs ~${(drawEquity * 100).toFixed(0)}% equity — calling is +EV`,
      });
    }
  }

  // ── Flag 9: Called with bad pot odds ──────────────────────────────────────
  for (const [street, streetActions, boardSlice] of [
    ['turn',  turn,  board.slice(0, 4)],
    ['river', river, board.slice(0, 5)],
  ]) {
    if (boardSlice.length < (street === 'turn' ? 4 : 5)) continue;
    const heroAct = streetActions.find(a => a.player === HERO);
    if (!heroAct || heroAct.action !== 'call') continue;

    if (getDrawEquity(holeCards, boardSlice, street) != null) continue; // has a draw
    const strength = evaluateHandStrength(holeCards, boardSlice);
    if (['two_pair_plus', 'overpair', 'top_pair'].includes(strength)) continue;

    let running  = potAtStreetStart(allActions, street);
    let lastBet  = 0;
    let potAtBet = 0;
    for (const a of streetActions) {
      if (a.player === HERO && a.action === 'call') break;
      if (a.action === 'bet' || a.action === 'raise') { potAtBet = running; lastBet = a.amount || 0; }
      running += (a.amount || 0);
    }
    if (lastBet <= 0 || potAtBet <= 0) continue;

    const callAmt = heroAct.amount || 0;
    if (callAmt > 0.66 * potAtBet) {
      const potOdds = callAmt / (potAtBet + lastBet + callAmt);
      flags.push({
        flag_type: 'call_bad_pot_odds',
        street,
        severity: 2,
        description: `Called ${callAmt.toFixed(2)} with ${handClass} (${strength.replace(/_/g, ' ')}) on ${street} facing a ${(lastBet / potAtBet * 100).toFixed(0)}% pot bet — pot odds ${(potOdds * 100).toFixed(0)}%, weak hand, no draw`,
      });
    }
  }

  // ── Flag 10: Donk bet — hero bet into the preflop aggressor ──────────────
  if (!heroPFR) {
    const pfr = preflopAggressor(preflop);
    if (pfr && pfr !== HERO) {
      for (const [street, streetActions] of [
        ['flop',  flop],
        ['turn',  turn],
        ['river', river],
      ]) {
        if (!streetActions.length) continue;
        // Hero must act before the PFR on this street (i.e. hero is first to bet into them)
        const heroActIdx = streetActions.findIndex(a => a.player === HERO);
        const pfrActIdx  = streetActions.findIndex(a => a.player === pfr);
        if (heroActIdx === -1 || pfrActIdx === -1) continue;
        if (heroActIdx >= pfrActIdx) continue; // PFR acted first or together
        const heroAct = streetActions[heroActIdx];
        if (heroAct.action !== 'bet') continue;
        // Confirm no one else bet before hero on this street
        const betBefore = streetActions.slice(0, heroActIdx).some(a => a.action === 'bet' || a.action === 'raise');
        if (betBefore) continue;
        const pot   = potAtStreetStart(allActions, street);
        const ratio = pot > 0 ? (heroAct.amount || 0) / pot : 0;
        flags.push({
          flag_type: 'donk_bet',
          street,
          severity: 1,
          description: `Donk bet ${(ratio * 100).toFixed(0)}% pot on the ${street} with ${handClass} into the preflop aggressor — consider check-raise or check-call instead`,
        });
      }
    }
  }

  // ── Flag 11: Never bluffed a busted draw ──────────────────────────────────
  if (heroPFR && isHU && board.length >= 5) {
    const hadDraw = hasFlushDraw(holeCards, flopCards) || getStraightDrawType(holeCards, flopCards) !== null;
    if (hadDraw) {
      const drawMissed = !hasMadeFlush(holeCards, board) && !hasMadeStraight(holeCards, board);
      if (drawMissed) {
        const everBet = [...flop, ...turn, ...river]
          .some(a => a.player === HERO && (a.action === 'bet' || a.action === 'raise'));
        if (!everBet) {
          const drawType = hasFlushDraw(holeCards, flopCards) ? 'flush draw'
            : getStraightDrawType(holeCards, flopCards) === 'oesd' ? 'OESD' : 'gutshot';
          flags.push({
            flag_type: 'never_bluffed_busted_draw',
            street: 'river',
            severity: 1,
            description: `Had a ${drawType} with ${handClass} on ${flopCards.join(' ')}, draw missed, but never bet — missed potential river bluff`,
          });
        }
      }
    }
  }

  // ── Flag 12: Bet-bet-bet with marginal hand ────────────────────────────────
  if (board.length >= 5 && heroWentToShowdown) {
    const heroBetF = flop.find(a => a.player === HERO && a.action === 'bet');
    const heroBetT = turn.find(a => a.player === HERO && a.action === 'bet');
    const heroBetR = river.find(a => a.player === HERO && a.action === 'bet');
    if (heroBetF && heroBetT && heroBetR) {
      const strength = evaluateHandStrength(holeCards, board);
      if (['pair_below_top', 'no_pair'].includes(strength)) {
        const bets = [heroBetF, heroBetT, heroBetR];
        const ratios = bets.map(b => {
          const pot = potBefore(allActions, b.action_order);
          return pot > 0 ? (b.amount || 0) / pot : 0;
        });
        const avgRatio = ratios.reduce((a, b) => a + b, 0) / 3;
        if (avgRatio > 0.5) {
          flags.push({
            flag_type: 'bet_bet_bet_marginal',
            street: 'river',
            severity: 2,
            description: `Bet flop/turn/river (avg ${(avgRatio * 100).toFixed(0)}% pot) with ${handClass} (${strength.replace(/_/g, ' ')}) — 3-street barrel usually needs strong hand or air`,
          });
        }
      }
    }
  }

  // ── Flag 13: Showdown in big pot with weak hand ────────────────────────────
  if (board.length >= 5 && heroWentToShowdown) {
    const potBB = (hand.total_pot || 0) / bigBlind;
    if (potBB >= 30) {
      const strength = evaluateHandStrength(holeCards, board);
      if (['pair_below_top', 'no_pair'].includes(strength)) {
        flags.push({
          flag_type: 'showdown_big_pot_weak_hand',
          street: 'river',
          severity: potBB >= 60 ? 3 : 2,
          description: `Went to showdown with ${handClass} (${strength.replace(/_/g, ' ')}) in a ${potBB.toFixed(0)} BB pot`,
        });
      }
    }
  }

  // ── Flag 14: Bet too small with strong hand ────────────────────────────────
  if (board.length >= 5 && heroWentToShowdown && heroRiverAct?.action === 'bet') {
    const strength = evaluateHandStrength(holeCards, board);
    if (strength === 'two_pair_plus') {
      const pot = potBefore(allActions, heroRiverAct.action_order);
      if (pot > 0) {
        const ratio = (heroRiverAct.amount || 0) / pot;
        if (ratio < 0.33) {
          flags.push({
            flag_type: 'bet_too_small_strong_hand',
            street: 'river',
            severity: 1,
            description: `Bet only ${(ratio * 100).toFixed(0)}% pot on river with ${handClass} (${strength.replace(/_/g, ' ')}) — potential missed value`,
          });
        }
      }
    }
  }

  // ── Flag 15: Checked back river IP with strong hand and won ───────────────
  if (board.length >= 5 && heroIsIP && heroWentToShowdown && heroRiverAct?.action === 'check') {
    const strength = evaluateHandStrength(holeCards, board);
    if (strength === 'two_pair_plus') {
      // Confirm hero won (amount_won > 0 and hand had a showdown)
      if ((hero.amount_won || 0) > 0) {
        const pot = potBefore(allActions, heroRiverAct.action_order);
        flags.push({
          flag_type: 'check_river_strong_hand',
          street: 'river',
          severity: 1,
          description: `Checked back river IP with ${handClass} (${strength.replace(/_/g, ' ')}) in a ${pot > 0 ? (pot / bigBlind).toFixed(0) + ' BB' : ''} pot and won — missed value by not betting`,
        });
      }
    }
  }

  return flags;
}

// ── Batch analysis ─────────────────────────────────────────────────────────────
async function analyzeAllHands() {
  const db = await getDb();

  // Hands already processed (flagged or marked analyzed)
  const alreadyDone = new Set(
    queryAll(db, 'SELECT DISTINCT hand_id FROM hand_flags').map(r => r.hand_id)
  );

  // All cash hands where we have hero's hole cards
  const eligible = queryAll(db, `
    SELECT h.hand_id
    FROM hands h
    JOIN hand_players hp ON h.hand_id = hp.hand_id
    WHERE h.is_tournament = 0
      AND hp.player = ?
      AND hp.hole_cards IS NOT NULL
      AND hp.hole_cards != '[]'
    ORDER BY h.date_played ASC
  `, [HERO]);

  const toAnalyze = eligible.filter(r => !alreadyDone.has(r.hand_id));

  let analyzed = 0, flagged = 0;

  for (const { hand_id } of toAnalyze) {
    try {
      const hand       = queryOne(db, 'SELECT * FROM hands WHERE hand_id = ?', [hand_id]);
      const hero       = queryOne(db, 'SELECT * FROM hand_players WHERE hand_id = ? AND player = ?', [hand_id, HERO]);
      const allPlayers = queryAll(db, 'SELECT * FROM hand_players WHERE hand_id = ?', [hand_id]);
      const allActions = queryAll(db, 'SELECT * FROM hand_actions WHERE hand_id = ? ORDER BY action_order', [hand_id]);

      if (!hand || !hero) continue;

      const newFlags = analyzeHand(hand, hero, allPlayers, allActions);

      if (newFlags.length > 0) {
        for (const f of newFlags) {
          db.run(
            'INSERT INTO hand_flags (hand_id, flag_type, street, severity, description) VALUES (?, ?, ?, ?, ?)',
            [hand_id, f.flag_type, f.street || null, f.severity, f.description]
          );
          flagged++;
        }
      } else {
        // Sentinel so we don't re-analyze this hand
        db.run(
          'INSERT OR IGNORE INTO hand_flags (hand_id, flag_type, street, severity, description) VALUES (?, ?, ?, ?, ?)',
          [hand_id, '_analyzed', null, 0, 'analyzed — no flags']
        );
      }
      analyzed++;
    } catch (err) {
      console.warn(`[analyzer] Error on hand ${hand_id}: ${err.message}`);
    }
  }

  saveDb();
  return { analyzed, flagged, skipped: alreadyDone.size };
}

module.exports = { analyzeAllHands };
