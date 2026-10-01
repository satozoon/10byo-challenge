/* ==========================================================================
 * 10秒チャレンジ - script.js
 * --------------------------------------------------------------------------
 * 設計方針：
 *   ・機能ごとに「名前空間オブジェクト」に分割し、疎結合に保つ。
 *     Storage / Records / Leaderboard / Audio / Shop / Daily / Level / Game / UI
 *   ・Leaderboard は将来 Firebase 等のオンラインDBに差し替えやすいよう、
 *     公開メソッドは全て Promise を返す非同期インターフェースにしている。
 *     （今はlocalStorageで実装、中身だけ差し替えればオンライン化できる）
 *   ・DOM操作は UI オブジェクトに集約し、他のロジックは画面の存在を知らない。
 * ========================================================================== */

'use strict';

/* ============================================================
 * 1. CONFIG - ゲーム全体の定数
 * ============================================================ */
const CONFIG = {
  // 誤差(秒) -> スコアの対応表。小さい誤差から順に判定する。
  SCORE_TABLE: [
    { maxDiff: 0.01, score: 100 },
    { maxDiff: 0.03, score: 98 },
    { maxDiff: 0.05, score: 95 },
    { maxDiff: 0.10, score: 90 },
    { maxDiff: 0.20, score: 80 },
    { maxDiff: 0.50, score: 60 },
    { maxDiff: 1.00, score: 40 },
    { maxDiff: Infinity, score: 0 },
  ],
  // スコア -> 判定ラベル
  JUDGEMENT_TABLE: [
    { minScore: 100, label: 'PERFECT', cls: 'judgement--perfect' },
    { minScore: 95, label: 'EXCELLENT', cls: 'judgement--excellent' },
    { minScore: 80, label: 'GREAT', cls: 'judgement--great' },
    { minScore: 40, label: 'GOOD', cls: 'judgement--good' },
    { minScore: 0, label: 'MISS', cls: 'judgement--miss' },
  ],
  // スコア -> ランク
  RANK_TABLE: [
    { minScore: 100, rank: 'SSS' },
    { minScore: 95, rank: 'SS' },
    { minScore: 90, rank: 'S' },
    { minScore: 80, rank: 'A' },
    { minScore: 60, rank: 'B' },
    { minScore: 40, rank: 'C' },
    { minScore: 0, rank: 'D' },
  ],
  RANK_ORDER: ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS'],
  COMBO_KEEP_THRESHOLD: 80, // このスコア以上でコンボ継続
  COMBO_MILESTONES: [3, 5, 10],
  BLIND_REVEAL_DELAY_BASE: 2.0, // ブラインドモードで隠すまでの秒数
  COIN_BASE: 10,               // プレイごとの基本コイン
  LEVEL_UP_SCORE: 500,         // 累積スコアいくつでレベルアップするか
  RANDOM_RANGE_BASE: { min: 5, max: 20 },
};

/* ============================================================
 * 2. Storage - localStorage の薄いラッパー
 * ============================================================ */
const Storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 容量オーバーやプライベートモード等は静かに無視する */
    }
  },
};

/* ============================================================
 * 3. Records - ベスト記録・コイン・所持アイテムなどの永続データ
 * ============================================================ */
const Records = {
  KEY: 'tsc_records_v1', // 10sec-challenge

  data: null,

  defaults() {
    return {
      bestScore: 0,
      bestCombo: 0,
      bestRank: null,       // 'SSS' など
      minError: null,       // 秒
      totalScoreForLevel: 0, // レベル計算用の累積スコア
      coins: 0,
      owned: ['bg-default', 'digit-default', 'button-default', 'se-classic'],
      equipped: { bg: 'bg-default', digit: 'digit-default', button: 'button-default', se: 'se-classic' },
      daily: { lastClearedDate: null, streak: 0 },
    };
  },

  load() {
    const saved = Storage.get(this.KEY, null);
    this.data = Object.assign(this.defaults(), saved || {});
    // ネストしたオブジェクトも欠損があれば補完しておく
    this.data.equipped = Object.assign(this.defaults().equipped, this.data.equipped || {});
    this.data.daily = Object.assign(this.defaults().daily, this.data.daily || {});
    return this.data;
  },

  save() {
    Storage.set(this.KEY, this.data);
  },

  // プレイ結果を反映し、更新があったかどうかの情報を返す
  applyResult({ score, comboAfter, diff }) {
    const updates = { newBestScore: false, newBestCombo: false, newBestRank: false, newMinError: false };

    if (score > this.data.bestScore) { this.data.bestScore = score; updates.newBestScore = true; }
    if (comboAfter > this.data.bestCombo) { this.data.bestCombo = comboAfter; updates.newBestCombo = true; }

    const rank = Level.scoreToRank(score);
    if (!this.data.bestRank || CONFIG.RANK_ORDER.indexOf(rank) > CONFIG.RANK_ORDER.indexOf(this.data.bestRank)) {
      this.data.bestRank = rank;
      updates.newBestRank = true;
    }
    if (this.data.minError === null || diff < this.data.minError) {
      this.data.minError = diff;
      updates.newMinError = true;
    }
    if (score > 0) this.data.totalScoreForLevel += score;

    this.save();
    return updates;
  },

  addCoins(amount) {
    this.data.coins = Math.max(0, this.data.coins + amount);
    this.save();
  },
};

/* ============================================================
 * 4. Leaderboard - ランキング機能
 *    ※現在はlocalStorage実装。将来オンライン化する場合は、
 *      submit() / getTop() の中身をFirestore等のAPI呼び出しに
 *      差し替えるだけで良いよう、公開インターフェースは非同期(Promise)。
 * ============================================================ */
const Leaderboard = {
  KEY: 'tsc_ranking_v1',
  MAX_ENTRIES_PER_MODE: 20,

  _loadAll() {
    return Storage.get(this.KEY, { normal: [], random: [], blind: [], endless: [] });
  },
  _saveAll(all) {
    Storage.set(this.KEY, all);
  },

  /**
   * スコアを送信する。
   * @param {{mode:string, score:number, stage?:number, date:string}} entry
   * @returns {Promise<void>}
   */
  submit(entry) {
    return new Promise((resolve) => {
      const all = this._loadAll();
      if (!all[entry.mode]) all[entry.mode] = [];
      all[entry.mode].push(entry);
      all[entry.mode].sort((a, b) => (b.score - a.score) || ((b.stage || 0) - (a.stage || 0)));
      all[entry.mode] = all[entry.mode].slice(0, this.MAX_ENTRIES_PER_MODE);
      this._saveAll(all);
      resolve();
    });
  },

  /**
   * 上位ランキングを取得する。
   * @param {string} mode
   * @param {number} n
   * @returns {Promise<Array>}
   */
  getTop(mode, n = 10) {
    return new Promise((resolve) => {
      const all = this._loadAll();
      resolve((all[mode] || []).slice(0, n));
    });
  },
};

/* ============================================================
 * 5. AudioEngine - Web Audio API による効果音生成（外部音源なし）
 * ============================================================ */
const AudioEngine = {
  ctx: null,

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  // SEパックごとの波形（ショップで切り替え可能）
  currentWave() {
    const se = Records.data.equipped.se;
    if (se === 'se-soft') return 'sine';
    if (se === 'se-arcade') return 'sawtooth';
    return 'square'; // se-classic
  },

  _tone(freq, duration, { type, gain = 0.15, delay = 0 } = {}) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type || this.currentWave();
    osc.frequency.value = freq;
    const t0 = ctx.currentTime + delay;
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  },

  playStart() { this._tone(660, 0.12); this._tone(880, 0.12, { delay: 0.06 }); },
  playStop() { this._tone(440, 0.1); },
  playSuccess(score) {
    // スコアが高いほど華やかな和音になる
    const notes = score >= 95 ? [523, 659, 784, 1047] : score >= 80 ? [523, 659, 784] : [523, 659];
    notes.forEach((f, i) => this._tone(f, 0.22, { delay: i * 0.045, gain: 0.13 }));
  },
  playFail() {
    this._tone(220, 0.18, { gain: 0.14 });
    this._tone(160, 0.28, { delay: 0.09, gain: 0.14 });
  },
  playCombo() { this._tone(988, 0.16, { gain: 0.16 }); this._tone(1319, 0.18, { delay: 0.07, gain: 0.16 }); },
  playCoin() { this._tone(1568, 0.08, { gain: 0.12, type: 'square' }); this._tone(2093, 0.12, { delay: 0.05, gain: 0.1, type: 'square' }); },
};

/* ============================================================
 * 6. Level - レベル／難易度計算
 * ============================================================ */
const Level = {
  current() {
    return Math.floor(Records.data.totalScoreForLevel / CONFIG.LEVEL_UP_SCORE) + 1;
  },

  // レベルに応じてランダム/エンドレスモードの目標時間レンジを広げる
  difficultyRange() {
    const lv = this.current();
    const expand = Math.min((lv - 1) * 1.5, 20); // 上限を設けて極端にならないようにする
    return {
      min: Math.max(3, CONFIG.RANDOM_RANGE_BASE.min - expand * 0.3),
      max: Math.min(40, CONFIG.RANDOM_RANGE_BASE.max + expand),
    };
  },

  // レベルに応じてブラインドモードの表示時間を短くする（下限0.5秒）
  blindRevealDelay() {
    const lv = this.current();
    return Math.max(0.5, CONFIG.BLIND_REVEAL_DELAY_BASE - (lv - 1) * 0.08);
  },

  scoreToRank(score) {
    const found = CONFIG.RANK_TABLE.find((r) => score >= r.minScore);
    return found ? found.rank : 'D';
  },
};

/* ============================================================
 * 7. Scoring - 誤差からスコア・判定を求める純粋関数群
 * ============================================================ */
const Scoring = {
  diffToScore(diff) {
    const found = CONFIG.SCORE_TABLE.find((row) => diff <= row.maxDiff);
    return found ? found.score : 0;
  },
  scoreToJudgement(score) {
    const found = CONFIG.JUDGEMENT_TABLE.find((row) => score >= row.minScore);
    return found || CONFIG.JUDGEMENT_TABLE[CONFIG.JUDGEMENT_TABLE.length - 1];
  },
};

/* ============================================================
 * 8. Daily - デイリーチャレンジ（日付から決定的に目標を生成）
 * ============================================================ */
const Daily = {
  todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  // 日付文字列を簡易ハッシュ化し、5.00〜20.00秒の目標を決定的に生成する
  targetForDate(dateStr) {
    let h = 0;
    for (let i = 0; i < dateStr.length; i++) {
      h = (h * 31 + dateStr.charCodeAt(i)) >>> 0;
    }
    const steps = h % 1501; // 0-1500 -> 0.00-15.00
    return Math.round((5 + steps / 100) * 100) / 100;
  },
  todayTarget() {
    return this.targetForDate(this.todayStr());
  },
  // クリア（スコア基準達成）を記録し、連続日数を更新する
  registerClear(score) {
    if (score < CONFIG.COMBO_KEEP_THRESHOLD) return; // 80点未満は「達成」に含めない
    const today = this.todayStr();
    const yesterday = this.yesterdayStr();
    const d = Records.data.daily;
    if (d.lastClearedDate === today) return; // 本日分は既に達成済み
    d.streak = d.lastClearedDate === yesterday ? d.streak + 1 : 1;
    d.lastClearedDate = today;
    Records.save();
  },
};

/* ============================================================
 * 9. Shop - ショップアイテム定義と購入/装備ロジック
 * ============================================================ */
const Shop = {
  items: [
    // --- 背景 ---
    { id: 'bg-default', cat: 'bg', name: 'デフォルト', cost: 0, css: { '--bg-grad': 'radial-gradient(circle at 20% 0%, #1a1035, #0a0e27 55%), radial-gradient(circle at 80% 100%, #150a2b, transparent 60%)' }, swatch: 'linear-gradient(135deg,#1a1035,#0a0e27)' },
    { id: 'bg-cyan', cat: 'bg', name: 'シアンウェーブ', cost: 50, css: { '--bg-grad': 'radial-gradient(circle at 20% 0%, #063a4a, #041018 55%), radial-gradient(circle at 80% 100%, #072a3a, transparent 60%)' }, swatch: 'linear-gradient(135deg,#063a4a,#041018)' },
    { id: 'bg-sunset', cat: 'bg', name: 'サンセットアーケード', cost: 80, css: { '--bg-grad': 'radial-gradient(circle at 20% 0%, #4a1030, #180418 55%), radial-gradient(circle at 80% 100%, #401a08, transparent 60%)' }, swatch: 'linear-gradient(135deg,#4a1030,#401a08)' },
    { id: 'bg-matrix', cat: 'bg', name: 'マトリクスグリーン', cost: 120, css: { '--bg-grad': 'radial-gradient(circle at 20% 0%, #052a12, #020805 55%), radial-gradient(circle at 80% 100%, #0a3a1a, transparent 60%)' }, swatch: 'linear-gradient(135deg,#052a12,#020805)' },
    // --- 数字色 ---
    { id: 'digit-default', cat: 'digit', name: 'シアン', cost: 0, css: { '--digit-color': '#00f0ff', '--digit-glow': '#00f0ff' }, swatch: '#00f0ff' },
    { id: 'digit-magenta', cat: 'digit', name: 'マゼンタ', cost: 40, css: { '--digit-color': '#ff2ee0', '--digit-glow': '#ff2ee0' }, swatch: '#ff2ee0' },
    { id: 'digit-gold', cat: 'digit', name: 'ゴールド', cost: 60, css: { '--digit-color': '#ffd23f', '--digit-glow': '#ffd23f' }, swatch: '#ffd23f' },
    { id: 'digit-lime', cat: 'digit', name: 'ライム', cost: 90, css: { '--digit-color': '#9dff3f', '--digit-glow': '#9dff3f' }, swatch: '#9dff3f' },
    // --- ボタン色 ---
    { id: 'button-default', cat: 'button', name: 'マゼンタ', cost: 0, css: { '--button-color': '#ff2ee0' }, swatch: '#ff2ee0' },
    { id: 'button-purple', cat: 'button', name: 'パープル', cost: 40, css: { '--button-color': '#7b2ff7' }, swatch: '#7b2ff7' },
    { id: 'button-red', cat: 'button', name: 'レッド', cost: 40, css: { '--button-color': '#ff3b3b' }, swatch: '#ff3b3b' },
    { id: 'button-gold', cat: 'button', name: 'ゴールド', cost: 90, css: { '--button-color': '#ffd23f' }, swatch: '#ffd23f' },
    // --- SE ---
    { id: 'se-classic', cat: 'se', name: 'クラシック', cost: 0, swatch: '#8b91c9' },
    { id: 'se-soft', cat: 'se', name: 'ソフト', cost: 50, swatch: '#8b91c9' },
    { id: 'se-arcade', cat: 'se', name: 'アーケード', cost: 70, swatch: '#8b91c9' },
  ],

  byId(id) { return this.items.find((it) => it.id === id); },
  byCat(cat) { return this.items.filter((it) => it.cat === cat); },

  isOwned(id) { return Records.data.owned.includes(id); },
  isEquipped(id) {
    const item = this.byId(id);
    return item && Records.data.equipped[item.cat] === id;
  },

  // 購入 or 装備。所持していなければコインを消費して購入し、そのまま装備する。
  purchaseOrEquip(id) {
    const item = this.byId(id);
    if (!item) return { ok: false, reason: 'not-found' };

    if (!this.isOwned(id)) {
      if (Records.data.coins < item.cost) return { ok: false, reason: 'not-enough-coins' };
      Records.data.coins -= item.cost;
      Records.data.owned.push(id);
    }
    Records.data.equipped[item.cat] = id;
    Records.save();
    this.applyEquipped();
    return { ok: true };
  },

  // 現在装備中のアイテムのCSS変数を :root に適用する
  applyEquipped() {
    const root = document.documentElement.style;
    ['bg', 'digit', 'button'].forEach((cat) => {
      const item = this.byId(Records.data.equipped[cat]);
      if (item && item.css) {
        Object.entries(item.css).forEach(([k, v]) => root.setProperty(k, v));
      }
    });
  },
};

/* ============================================================
 * 10. Effects - CSSアニメーションを起動するだけの薄い制御層
 * ============================================================ */
const Effects = {
  confettiColors: ['#00f0ff', '#ff2ee0', '#ffd23f', '#7b2ff7', '#37e07a'],

  shakeScreen() {
    const app = document.getElementById('app');
    app.classList.remove('is-shaking');
    // reflowを挟んで再アニメーションできるようにする
    void app.offsetWidth;
    app.classList.add('is-shaking');
  },

  popTimer() {
    const timer = document.getElementById('timerDisplay');
    timer.classList.remove('is-pop');
    void timer.offsetWidth;
    timer.classList.add('is-pop');
  },

  confettiBurst(count = 36) {
    const layer = document.getElementById('confettiLayer');
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      const color = this.confettiColors[Math.floor(Math.random() * this.confettiColors.length)];
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = color;
      piece.style.animationDuration = `${1.2 + Math.random() * 1.1}s`;
      piece.style.animationDelay = `${Math.random() * 0.25}s`;
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      layer.appendChild(piece);
      // アニメーション終了後に自動で除去してDOMを肥大化させない
      piece.addEventListener('animationend', () => piece.remove());
    }
  },

  comboFlash(comboCount) {
    const el = document.getElementById('comboFlash');
    el.textContent = `${comboCount} COMBO!`;
    el.classList.remove('is-active');
    void el.offsetWidth;
    el.classList.add('is-active');
  },
};

/* ============================================================
 * 11. Game - ゲーム本体のステートマシン
 * ============================================================ */
const Game = {
  mode: null,          // 'normal' | 'random' | 'blind' | 'endless' | 'daily'
  targetTime: 0,
  startTimestamp: 0,
  rafId: null,
  running: false,
  blindTimeoutId: null,
  comboCount: 0,
  endlessStage: 1,
  endlessTotalScore: 0,
  isDailyRun: false,

  // モードごとの目標時間を決定する
  pickTargetTime(mode) {
    if (mode === 'normal') return 10.0;
    if (mode === 'random' || mode === 'blind') {
      const range = Level.difficultyRange();
      return Math.round((range.min + Math.random() * (range.max - range.min)) * 100) / 100;
    }
    if (mode === 'endless') {
      const range = Level.difficultyRange();
      return Math.round((range.min + Math.random() * (range.max - range.min)) * 100) / 100;
    }
    if (mode === 'daily') return Daily.todayTarget();
    return 10.0;
  },

  start(mode, opts = {}) {
    this.mode = mode;
    this.isDailyRun = mode === 'daily';
    if (mode === 'endless' && !opts.continuing) {
      this.endlessStage = 1;
      this.endlessTotalScore = 0;
      this.comboCount = 0;
    }
    this.targetTime = opts.forcedTarget != null ? opts.forcedTarget : this.pickTargetTime(mode);

    UI.enterGameScreen(this);

    this.running = true;
    this.startTimestamp = performance.now();
    AudioEngine.playStart();

    UI.setStartStopEnabled(false, true);

    // ブラインドモード：一定時間後に表示を隠す
    if (mode === 'blind') {
      const delay = Level.blindRevealDelay() * 1000;
      this.blindTimeoutId = setTimeout(() => {
        if (this.running) UI.hideTimerForBlind();
      }, delay);
    }

    this._loop();
  },

  _loop() {
    const elapsed = (performance.now() - this.startTimestamp) / 1000;
    UI.updateTimerText(elapsed);
    this.rafId = requestAnimationFrame(() => this._loop());
  },

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.blindTimeoutId);

    const elapsed = (performance.now() - this.startTimestamp) / 1000;
    UI.updateTimerText(elapsed, true);
    AudioEngine.playStop();

    const diff = Math.round(Math.abs(elapsed - this.targetTime) * 100) / 100;
    const score = Scoring.diffToScore(diff);
    const judgement = Scoring.scoreToJudgement(score);

    // コンボ更新
    if (score >= CONFIG.COMBO_KEEP_THRESHOLD) {
      this.comboCount += 1;
    } else {
      this.comboCount = 0;
    }

    // エンドレスモードの進行管理
    let endlessContinue = false;
    if (this.mode === 'endless') {
      this.endlessTotalScore += score;
      if (score >= CONFIG.COMBO_KEEP_THRESHOLD) {
        endlessContinue = true;
      }
    }

    // コイン計算：基本10枚 + スコアに応じたボーナス（最大+10）
    const coinBonus = Math.floor(score / 10);
    const coinGain = CONFIG.COIN_BASE + coinBonus;
    Records.addCoins(coinGain);

    const recordUpdates = Records.applyResult({ score, comboAfter: this.comboCount, diff });

    if (this.isDailyRun) Daily.registerClear(score);

    // ランキング送信（ノーマル/ランダム/ブラインドはその場のスコア、エンドレスは累計）
    const rankMode = this.mode === 'daily' ? 'normal' : this.mode;
    Leaderboard.submit({
      mode: rankMode,
      score: this.mode === 'endless' ? this.endlessTotalScore : score,
      stage: this.mode === 'endless' ? this.endlessStage : undefined,
      date: Daily.todayStr(),
    });

    const result = {
      mode: this.mode,
      target: this.targetTime,
      elapsed,
      diff,
      score,
      judgement,
      rank: Level.scoreToRank(score),
      combo: this.comboCount,
      coinGain,
      recordUpdates,
      endless: this.mode === 'endless' ? {
        stage: this.endlessStage,
        totalScore: this.endlessTotalScore,
        continuing: endlessContinue,
      } : null,
    };

    UI.setStartStopEnabled(true, false);
    UI.showResult(result);

    if (this.mode === 'endless' && endlessContinue) {
      this.endlessStage += 1;
    }
  },

  // エンドレスモードで「次のステージへ」進む
  continueEndless() {
    this.start('endless', { continuing: true });
  },
};

/* ============================================================
 * 12. UI - 画面遷移・DOM描画をまとめて担当
 * ============================================================ */
const UI = {
  els: {},

  cache() {
    const ids = [
      'coinCount', 'levelCount', 'gameModeLabel', 'gameComboLabel', 'targetBadge',
      'targetTimeText', 'timerDisplay', 'stageBadge', 'stageCount', 'startBtn', 'stopBtn',
      'judgementText', 'resultScore', 'rankBadge', 'resultTarget', 'resultElapsed',
      'resultDiff', 'resultCoins', 'resultEndless', 'resultStage', 'retryBtn',
      'dailyDate', 'dailyTargetText', 'dailyStreak', 'dailyStartBtn',
      'shopCoinCount', 'shopGrid', 'rankingList',
      'recBestScore', 'recBestCombo', 'recBestRank', 'recMinError',
    ];
    ids.forEach((id) => { this.els[id] = document.getElementById(id); });
  },

  /* ---------- 画面遷移 ---------- */
  navTo(screenId) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('screen--active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('screen--active');
    if (screenId === 'screen-shop') this.renderShop(this._shopCat || 'bg');
    if (screenId === 'screen-ranking') this.renderRanking(this._rankMode || 'normal');
    if (screenId === 'screen-records') this.renderRecords();
    if (screenId === 'screen-daily') this.renderDaily();
    this.refreshHUD();
  },

  refreshHUD() {
    this.els.coinCount.textContent = Records.data.coins;
    this.els.levelCount.textContent = Level.current();
  },

  /* ---------- ゲーム画面 ---------- */
  enterGameScreen(game) {
    this.navTo('screen-game');
    const modeNames = { normal: 'NORMAL', random: 'RANDOM', blind: 'BLIND', endless: 'ENDLESS', daily: 'DAILY' };
    this.els.gameModeLabel.textContent = modeNames[game.mode] || game.mode.toUpperCase();
    this.els.gameComboLabel.textContent = `COMBO ${game.comboCount}`;
    this.els.targetBadge.classList.remove('is-hidden');
    this.els.targetTimeText.textContent = game.targetTime.toFixed(2);
    this.els.timerDisplay.textContent = '0.00';

    if (game.mode === 'endless') {
      this.els.stageBadge.hidden = false;
      this.els.stageCount.textContent = game.endlessStage;
    } else {
      this.els.stageBadge.hidden = true;
    }
  },

  updateTimerText(elapsed) {
    this.els.timerDisplay.textContent = elapsed.toFixed(2);
  },

  hideTimerForBlind() {
    this.els.targetTimeText.textContent = '???';
    this.els.targetBadge.classList.add('is-hidden');
  },

  setStartStopEnabled(startEnabled, stopEnabled) {
    this.els.startBtn.disabled = !startEnabled;
    this.els.stopBtn.disabled = !stopEnabled;
  },

  /* ---------- 結果画面 ---------- */
  showResult(result) {
    this.navTo('screen-result');

    const j = result.judgement;
    this.els.judgementText.textContent = j.label;
    this.els.judgementText.className = `judgement ${j.cls}`;

    this.els.resultScore.textContent = result.score;
    this.els.rankBadge.textContent = result.rank;
    this.els.resultTarget.textContent = `${result.target.toFixed(2)}秒`;
    this.els.resultElapsed.textContent = `${result.elapsed.toFixed(2)}秒`;
    this.els.resultDiff.textContent = `${result.diff.toFixed(2)}秒`;
    this.els.resultCoins.textContent = `+${result.coinGain}`;

    if (result.endless) {
      this.els.resultEndless.hidden = false;
      this.els.resultStage.textContent = result.endless.stage;
      this.els.retryBtn.textContent = result.endless.continuing ? '次のステージへ' : 'もう一度';
    } else {
      this.els.resultEndless.hidden = true;
      this.els.retryBtn.textContent = 'もう一度';
    }

    this.refreshHUD();

    // ---- 演出 ----
    Effects.popTimer();
    if (result.score >= CONFIG.COMBO_KEEP_THRESHOLD) {
      AudioEngine.playSuccess(result.score);
      if (result.score >= 95) Effects.confettiBurst(result.score === 100 ? 60 : 40);
      if (CONFIG.COMBO_MILESTONES.includes(result.combo) || (result.combo > 0 && result.combo % 10 === 0)) {
        Effects.comboFlash(result.combo);
        AudioEngine.playCombo();
      }
    } else {
      AudioEngine.playFail();
      Effects.shakeScreen();
    }
    if (result.coinGain > 0) AudioEngine.playCoin();
  },

  /* ---------- デイリー画面 ---------- */
  renderDaily() {
    const d = new Date();
    this.els.dailyDate.textContent = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    this.els.dailyTargetText.textContent = `${Daily.todayTarget().toFixed(2)}秒`;
    this.els.dailyStreak.textContent = Records.data.daily.streak;
  },

  /* ---------- ショップ画面 ---------- */
  renderShop(cat) {
    this._shopCat = cat;
    document.querySelectorAll('.shop-tab[data-cat]').forEach((tab) => {
      tab.classList.toggle('shop-tab--active', tab.dataset.cat === cat);
    });
    this.els.shopCoinCount.textContent = Records.data.coins;

    const grid = this.els.shopGrid;
    grid.innerHTML = '';
    Shop.byCat(cat).forEach((item) => {
      const owned = Shop.isOwned(item.id);
      const equipped = Shop.isEquipped(item.id);
      const canAfford = Records.data.coins >= item.cost;

      const card = document.createElement('div');
      card.className = 'shop-item';

      const swatch = document.createElement('div');
      swatch.className = 'shop-item__swatch';
      swatch.style.background = item.swatch;
      card.appendChild(swatch);

      const name = document.createElement('div');
      name.className = 'shop-item__name';
      name.textContent = item.name;
      card.appendChild(name);

      const price = document.createElement('div');
      price.className = 'shop-item__price';
      price.textContent = item.cost === 0 ? '無料' : `🪙 ${item.cost}`;
      card.appendChild(price);

      const btn = document.createElement('button');
      btn.className = 'shop-item__btn';
      if (equipped) {
        btn.textContent = '装備中';
        btn.dataset.state = 'equipped';
      } else if (owned) {
        btn.textContent = '装備する';
        btn.dataset.state = 'owned';
      } else if (canAfford) {
        btn.textContent = '購入する';
        btn.dataset.state = 'buyable';
      } else {
        btn.textContent = 'コイン不足';
        btn.dataset.state = 'locked';
        btn.disabled = true;
      }
      btn.addEventListener('click', () => {
        const res = Shop.purchaseOrEquip(item.id);
        if (res.ok) {
          if (item.cat === 'se') AudioEngine.playCombo();
          this.renderShop(cat);
          this.refreshHUD();
        }
      });
      card.appendChild(btn);

      grid.appendChild(card);
    });
  },

  /* ---------- ランキング画面 ---------- */
  renderRanking(mode) {
    this._rankMode = mode;
    document.querySelectorAll('.shop-tab[data-rank-mode]').forEach((tab) => {
      tab.classList.toggle('shop-tab--active', tab.dataset.rankMode === mode);
    });
    const list = this.els.rankingList;
    list.innerHTML = '';
    Leaderboard.getTop(mode, 10).then((entries) => {
      if (entries.length === 0) {
        const li = document.createElement('li');
        li.className = 'rank-empty';
        li.textContent = 'まだ記録がありません';
        list.appendChild(li);
        return;
      }
      entries.forEach((e, i) => {
        const li = document.createElement('li');
        const left = document.createElement('span');
        left.textContent = `${i + 1}. ${e.score}pt`;
        const right = document.createElement('span');
        right.textContent = e.stage ? `Stage ${e.stage}` : e.date;
        li.appendChild(left);
        li.appendChild(right);
        list.appendChild(li);
      });
    });
  },

  /* ---------- 記録画面 ---------- */
  renderRecords() {
    this.els.recBestScore.textContent = Records.data.bestScore;
    this.els.recBestCombo.textContent = Records.data.bestCombo;
    this.els.recBestRank.textContent = Records.data.bestRank || '-';
    this.els.recMinError.textContent = Records.data.minError === null ? '-' : `${Records.data.minError.toFixed(2)}秒`;
  },
};

/* ============================================================
 * 13. イベント配線 & 初期化
 * ============================================================ */
function bindEvents() {
  // data-nav属性を持つ全ボタンで画面遷移
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => UI.navTo(btn.dataset.nav));
  });

  // モード選択
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      AudioEngine.ensureContext();
      Game.start(card.dataset.mode);
    });
  });

  // スタート/ストップ
  UI.els.startBtn.addEventListener('click', () => {
    AudioEngine.ensureContext();
    Game.start(Game.mode || 'normal');
  });
  UI.els.stopBtn.addEventListener('click', () => Game.stop());

  // 結果画面：もう一度
  UI.els.retryBtn.addEventListener('click', () => {
    if (Game.mode === 'endless') {
      const shouldContinue = UI.els.retryBtn.textContent === '次のステージへ';
      if (shouldContinue) { Game.continueEndless(); return; }
    }
    if (Game.isDailyRun) { Game.start('daily'); return; }
    Game.start(Game.mode);
  });

  // デイリーチャレンジ開始
  UI.els.dailyStartBtn.addEventListener('click', () => {
    AudioEngine.ensureContext();
    Game.start('daily');
  });

  // ショップタブ
  document.querySelectorAll('.shop-tab[data-cat]').forEach((tab) => {
    tab.addEventListener('click', () => UI.renderShop(tab.dataset.cat));
  });

  // ランキングタブ
  document.querySelectorAll('.shop-tab[data-rank-mode]').forEach((tab) => {
    tab.addEventListener('click', () => UI.renderRanking(tab.dataset.rankMode));
  });
}

function init() {
  Records.load();
  UI.cache();
  Shop.applyEquipped();
  bindEvents();
  UI.navTo('screen-title');

  // PWA: Service Worker登録（対応環境のみ／file://等では失敗しても無視）
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン非対応環境は無視 */ });
  }
}

document.addEventListener('DOMContentLoaded', init);
