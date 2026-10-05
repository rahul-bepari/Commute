/* =========================================================================
   COMMUTE — script.js
   A fare-estimation and bus-route helper for cities (built around Dhaka)
   where rickshaw/CNG pricing has no official meter or app.

   Sections in this file:
     1. CONFIG        — curated baseline numbers, tweak these for your city
     2. HAVERSINE      — straight-line distance + learned "detour factor"
     3. DB             — IndexedDB wrapper (fare logs, frequent routes, settings)
     4. CROWD-DATA     — blending formula estimate with real logged fares
     5. FARE-ESTIMATOR — turns distance + context into a fair price range
     6. BUS-ROUTES     — search over the bundled offline bus dataset
     7. PWA            — service worker registration + online/offline UI
     8. APP / UI       — wires everything to the DOM
   ========================================================================= */

'use strict';

/* =========================================================================
   1. CONFIG
   These are hand-curated starting numbers, not official tariffs — nobody
   publishes one. Treat them as a reasonable starting point that the
   crowd-data layer (section 4) gradually corrects using real logged fares.
   ========================================================================= */
const CONFIG = {
  // Baseline taka pricing per vehicle type. `base` is a flat starting
  // charge (roughly what a very short hop costs), `perKm` is the
  // marginal rate for the estimated *road* distance (not straight-line).
  RATE_TABLE: {
    rickshaw: { label: 'রিকশা', base: 10, perKm: 8 },
    cng:      { label: 'সিএনজি অটো', base: 40, perKm: 20 }
  },

  // Straight-line (Haversine) distance always undercounts real road
  // distance because roads aren't straight. This is the starting
  // correction factor before any real data exists — it gets replaced by
  // a learned value once there are enough logged rides (see section 2/4).
  DEFAULT_DETOUR_FACTOR: 1.35,
  MIN_DETOUR_FACTOR: 1.0,
  MAX_DETOUR_FACTOR: 2.5,

  // Peak-hour surge: rough rush-hour windows where traffic makes drivers
  // charge more. Multiplier applied to the formula estimate.
  PEAK_WINDOWS: [ [8, 10.5], [17, 20.5] ],
  PEAK_MULTIPLIER: 1.15,

  // Flat percentage added when it's raining — rain reliably pushes
  // rickshaw/CNG prices up in Dhaka because supply drops.
  RAIN_SURCHARGE_PCT: 0.25,

  // Width of the displayed "fair price range" around the point estimate.
  FAIR_RANGE_TOLERANCE: 0.15,

  // How many community-logged data points before we call confidence
  // "high" / "medium" / "low". Below the first threshold we call it
  // "estimate only" and show the formula number alone.
  CONFIDENCE_THRESHOLDS: { low: 1, medium: 3, high: 10 },

  // Recency half-life (days) for weighting logged fares — older logs
  // count for less because prices drift with inflation/fuel cost.
  RECENCY_HALF_LIFE_DAYS: 90,

  // Shrinkage constant for blending formula vs community average.
  // Community weight = n / (n + BLEND_K). Bigger K means the app trusts
  // the formula longer before leaning on crowd data.
  BLEND_K: 3
};

/* =========================================================================
   2. HAVERSINE — great-circle distance + detour correction
   ========================================================================= */
const Haversine = {
  /**
   * Straight-line distance between two lat/lng points, in kilometres.
   * Standard Haversine formula, written out from scratch (no map SDK).
   */
  distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371; // mean Earth radius, km
    const toRad = deg => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  /**
   * Straight-line distance is never the real road distance a rickshaw
   * travels — roads curve, one-ways force detours, etc. We multiply by a
   * "detour factor" to approximate real road distance. That factor starts
   * at a curated default and is *learned* over time (see CrowdData.
   * recalculateDetourFactor) from the ratio between what people actually
   * paid (converted back into an implied distance via the rate table) and
   * the straight-line distance for that same trip.
   */
  roadDistanceKm(straightLineKm, detourFactor) {
    return straightLineKm * detourFactor;
  }
};

/* =========================================================================
   3. DB — thin IndexedDB wrapper
   Stores:
     fareLogs        { id, routeKey, fromId, toId, fromLabel, toLabel,
                        distanceKm (straight-line), fareTaka, vehicle,
                        rain, timestamp }
     frequentRoutes   { routeKey, fromId, toId, fromLabel, toLabel,
                         lastUsed, count }
     settings         { key, value }   -- used for the learned detour factor
   ========================================================================= */
const DB = {
  _db: null,
  NAME: 'commuteDB',
  VERSION: 1,

  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.NAME, this.VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('fareLogs')) {
          const store = db.createObjectStore('fareLogs', { keyPath: 'id', autoIncrement: true });
          store.createIndex('routeKey', 'routeKey', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains('frequentRoutes')) {
          db.createObjectStore('frequentRoutes', { keyPath: 'routeKey' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async _tx(storeName, mode) {
    const db = await this.open();
    return db.transaction(storeName, mode).objectStore(storeName);
  },

  async addFareLog(entry) {
    const store = await this._tx('fareLogs', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.add(entry);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getLogsByRouteKey(routeKey) {
    const store = await this._tx('fareLogs', 'readonly');
    return new Promise((resolve, reject) => {
      const idx = store.index('routeKey');
      const req = idx.getAll(routeKey);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllFareLogs() {
    const store = await this._tx('fareLogs', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async deleteFareLog(id) {
    const store = await this._tx('fareLogs', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async touchFrequentRoute(routeKey, data) {
    const store = await this._tx('frequentRoutes', 'readwrite');
    return new Promise((resolve, reject) => {
      const getReq = store.get(routeKey);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        const record = {
          routeKey,
          fromId: data.fromId, toId: data.toId,
          fromLabel: data.fromLabel, toLabel: data.toLabel,
          lastUsed: Date.now(),
          count: (existing ? existing.count : 0) + 1
        };
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve(record);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  },

  async getFrequentRoutes(limit = 6) {
    const store = await this._tx('frequentRoutes', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = req.result.sort((a, b) => (b.count - a.count) || (b.lastUsed - a.lastUsed));
        resolve(rows.slice(0, limit));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getSetting(key, fallback) {
    const store = await this._tx('settings', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = () => reject(req.error);
    });
  },

  async setSetting(key, value) {
    const store = await this._tx('settings', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  }
};

/* =========================================================================
   4. CROWD-DATA — blend the hand-written formula with real logged fares
   ========================================================================= */
const CrowdData = {
  /** Canonical key for a route so A→B and B→A logs share history. */
  routeKey(idA, idB) {
    return [idA, idB].sort().join('|');
  },

  /**
   * Recency-weighted average of what people actually paid on this route.
   * Each log's weight decays exponentially with age (half-life from
   * CONFIG.RECENCY_HALF_LIFE_DAYS) so a fare from last week matters more
   * than one from eight months ago (fuel prices / inflation drift).
   */
  weightedAverageFare(logs) {
    if (!logs.length) return null;
    const now = Date.now();
    const halfLifeMs = CONFIG.RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    let weightSum = 0;
    let weightedFareSum = 0;
    for (const log of logs) {
      const ageMs = Math.max(0, now - log.timestamp);
      // exponential decay: weight halves every `halfLifeMs`
      const weight = Math.pow(0.5, ageMs / halfLifeMs);
      weightSum += weight;
      weightedFareSum += weight * log.fareTaka;
    }
    return weightedFareSum / weightSum;
  },

  /**
   * Confidence tier purely from sample size of *this specific route*.
   * Kept transparent and simple on purpose — the UI shows this label so
   * a user waiting on the street instantly knows how much to trust it.
   */
  confidenceTier(n) {
    const t = CONFIG.CONFIDENCE_THRESHOLDS;
    if (n >= t.high) return 'high';
    if (n >= t.medium) return 'medium';
    if (n >= t.low) return 'low';
    return 'none';
  },

  /**
   * Blend the formula estimate with the community average using a simple
   * Bayesian-style shrinkage: the more real data points a route has, the
   * more the blended number leans toward what people actually paid.
   *   communityWeight = n / (n + K)
   * With K = CONFIG.BLEND_K: n=0 -> weight 0 (pure formula), n=3 -> 0.5,
   * n=10 -> ~0.77, n large -> approaches 1 (mostly community data).
   */
  blend(formulaFare, communityAvg, n) {
    if (communityAvg == null || n === 0) return formulaFare;
    const communityWeight = n / (n + CONFIG.BLEND_K);
    return communityAvg * communityWeight + formulaFare * (1 - communityWeight);
  },

  /**
   * Learn the detour factor (see Haversine.roadDistanceKm) from real
   * logs. For every logged fare we back out an "implied distance" by
   * inverting the rate-table formula: implied = (paidFare - base) / perKm.
   * Comparing implied distance to the straight-line (Haversine) distance
   * for that same trip gives an observed detour ratio. We average those
   * ratios across all logs (recency-weighted the same way as fares) and
   * blend that observed average with the curated default, again using
   * sample-size shrinkage — so a handful of noisy logs can't swing the
   * whole app, but a large body of logs gradually overrides our guess.
   */
  async recalculateDetourFactor() {
    const logs = await DB.getAllFareLogs();
    if (!logs.length) return CONFIG.DEFAULT_DETOUR_FACTOR;

    const now = Date.now();
    const halfLifeMs = CONFIG.RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    let weightSum = 0;
    let weightedRatioSum = 0;

    for (const log of logs) {
      const rate = CONFIG.RATE_TABLE[log.vehicle] || CONFIG.RATE_TABLE.rickshaw;
      if (!log.distanceKm || log.distanceKm <= 0) continue;
      const impliedDistance = (log.fareTaka - rate.base) / rate.perKm;
      if (impliedDistance <= 0) continue; // fare too low to be trustworthy, skip

      const ratio = impliedDistance / log.distanceKm;
      // Ignore wild outliers (fat-fingered entries) before they pollute the average.
      if (ratio < 0.6 || ratio > 4) continue;

      const ageMs = Math.max(0, now - log.timestamp);
      const weight = Math.pow(0.5, ageMs / halfLifeMs);
      weightSum += weight;
      weightedRatioSum += weight * ratio;
    }

    if (weightSum === 0) return CONFIG.DEFAULT_DETOUR_FACTOR;

    const observedFactor = weightedRatioSum / weightSum;
    // Shrink toward the curated default until enough logs accumulate,
    // same n/(n+K) logic as the fare blend above.
    const n = logs.length;
    const communityWeight = n / (n + CONFIG.BLEND_K);
    let blended = observedFactor * communityWeight + CONFIG.DEFAULT_DETOUR_FACTOR * (1 - communityWeight);
    blended = Math.min(CONFIG.MAX_DETOUR_FACTOR, Math.max(CONFIG.MIN_DETOUR_FACTOR, blended));

    await DB.setSetting('detourFactor', blended);
    await DB.setSetting('detourSampleCount', n);
    return blended;
  },

  async getDetourFactor() {
    return DB.getSetting('detourFactor', CONFIG.DEFAULT_DETOUR_FACTOR);
  }
};

/* =========================================================================
   5. FARE-ESTIMATOR — distance + context -> a fair price range
   ========================================================================= */
const FareEstimator = {
  isPeakNow(date = new Date()) {
    const hour = date.getHours() + date.getMinutes() / 60;
    return CONFIG.PEAK_WINDOWS.some(([start, end]) => hour >= start && hour <= end);
  },

  /**
   * Pure hand-written formula estimate (no crowd data). Returns the raw
   * point estimate plus a breakdown so the UI can show its work.
   */
  formulaEstimate({ straightLineKm, detourFactor, vehicle, rain }) {
    const rate = CONFIG.RATE_TABLE[vehicle] || CONFIG.RATE_TABLE.rickshaw;
    const roadKm = Haversine.roadDistanceKm(straightLineKm, detourFactor);

    const distanceCost = rate.perKm * roadKm;
    let total = rate.base + distanceCost;

    const peak = this.isPeakNow();
    const surgeAmount = peak ? total * (CONFIG.PEAK_MULTIPLIER - 1) : 0;
    total += surgeAmount;

    const rainAmount = rain ? total * CONFIG.RAIN_SURCHARGE_PCT : 0;
    total += rainAmount;

    return {
      roadKm,
      base: rate.base,
      perKm: rate.perKm,
      distanceCost,
      isPeak: peak,
      surgeAmount,
      rainAmount,
      total
    };
  },

  /** Round to the nearest 5 taka — real cash bargaining doesn't do decimals. */
  roundTaka(n) {
    return Math.round(n / 5) * 5;
  },

  fairRange(pointEstimate) {
    const low = this.roundTaka(pointEstimate * (1 - CONFIG.FAIR_RANGE_TOLERANCE));
    const high = this.roundTaka(pointEstimate * (1 + CONFIG.FAIR_RANGE_TOLERANCE));
    return { low: Math.max(low, 5), high: Math.max(high, low + 5) };
  }
};

/* =========================================================================
   6. BUS-ROUTES — search over the bundled offline dataset
   ========================================================================= */
const BusRoutes = {
  routes: [],
  meta: {},

  async load() {
    const res = await fetch('data/bus-routes.json');
    const json = await res.json();
    this.routes = json.routes;
    this.meta = { note_bn: json.note_bn, note_en: json.note_en };
    return this.routes;
  },

  /**
   * Find routes that serve both landmarks, in either direction. Ranked so
   * routes where the two stops are closer together in the stop list (a
   * more "direct" segment of that route) come first.
   */
  findBetween(fromId, toId) {
    const matches = [];
    for (const route of this.routes) {
      const iFrom = route.stops.indexOf(fromId);
      const iTo = route.stops.indexOf(toId);
      if (iFrom === -1 || iTo === -1 || iFrom === iTo) continue;
      matches.push({
        route,
        forward: iFrom < iTo,
        hops: Math.abs(iTo - iFrom),
        iFrom, iTo
      });
    }
    matches.sort((a, b) => a.hops - b.hops);
    return matches;
  }
};

/* =========================================================================
   7. PWA — service worker + connectivity indicator
   ========================================================================= */
const PWA = {
  init() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {
          // Offline-first app still works without SW registration succeeding
          // (e.g. first load with no network) — data/ was already fetched.
        });
      });
    }
    this.updateNetStatus();
    window.addEventListener('online', () => this.updateNetStatus());
    window.addEventListener('offline', () => this.updateNetStatus());
  },

  updateNetStatus() {
    const pill = document.getElementById('net-status');
    const label = document.getElementById('net-status-label');
    if (!pill || !label) return;
    if (navigator.onLine) {
      pill.classList.remove('offline');
      label.textContent = 'অনলাইন';
    } else {
      pill.classList.add('offline');
      label.textContent = 'অফলাইন — সংরক্ষিত তথ্য দিয়ে কাজ চলছে';
    }
  }
};

/* =========================================================================
   8. APP / UI — DOM wiring
   ========================================================================= */
const App = {
  landmarks: [],
  landmarkById: {},
  selected: { from: null, to: null },
  busSelected: { from: null, to: null },
  lastEstimate: null, // holds context needed for "log actual fare"
  detourFactor: CONFIG.DEFAULT_DETOUR_FACTOR,

  async init() {
    PWA.init();
    await this.loadLandmarks();
    await BusRoutes.load().catch(() => { /* offline first load without cache: degrade gracefully */ });
    this.detourFactor = await CrowdData.getDetourFactor();

    this.bindTabs();
    this.bindAutocomplete('from-input', 'from-list', (lm) => { this.selected.from = lm; });
    this.bindAutocomplete('to-input', 'to-list', (lm) => { this.selected.to = lm; });
    this.bindAutocomplete('bus-from-input', 'bus-from-list', (lm) => { this.busSelected.from = lm; });
    this.bindAutocomplete('bus-to-input', 'bus-to-list', (lm) => { this.busSelected.to = lm; });

    document.getElementById('swap-btn').addEventListener('click', () => this.swapFields('from', 'to'));
    document.getElementById('bus-swap-btn').addEventListener('click', () => this.swapFields('bus-from', 'bus-to', true));

    document.getElementById('fare-form').addEventListener('submit', (e) => { e.preventDefault(); this.handleEstimate(); });
    document.getElementById('bus-form').addEventListener('submit', (e) => { e.preventDefault(); this.handleBusSearch(); });

    document.getElementById('bargain-btn').addEventListener('click', () => this.showBargainLine());
    document.getElementById('log-fare-btn').addEventListener('click', () => this.openLogPanel());
    document.getElementById('log-cancel-btn').addEventListener('click', () => this.closeLogPanel());
    document.getElementById('log-submit-btn').addEventListener('click', () => this.submitFareLog());

    const dsNote = document.querySelector('.dataset-note');
    if (dsNote && BusRoutes.meta.note_bn) dsNote.textContent = BusRoutes.meta.note_bn;

    this.renderFrequentRoutes();
    this.renderHistoryTab();
  },

  async loadLandmarks() {
    const res = await fetch('data/landmarks.json');
    this.landmarks = await res.json();
    this.landmarkById = Object.fromEntries(this.landmarks.map(l => [l.id, l]));
  },

  /* ---------- tabs ---------- */
  bindTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        if (tab.dataset.tab === 'history') this.renderHistoryTab();
      });
    });
  },

  /* ---------- autocomplete ---------- */
  bindAutocomplete(inputId, listId, onSelect) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);

    const render = (query) => {
      const q = query.trim().toLowerCase();
      if (!q) { list.hidden = true; list.innerHTML = ''; return; }
      const results = this.landmarks
        .filter(lm => lm.name_bn.includes(query.trim()) || lm.name_en.toLowerCase().includes(q))
        .slice(0, 8);
      if (!results.length) { list.hidden = true; list.innerHTML = ''; return; }
      list.innerHTML = results.map(lm =>
        `<li data-id="${lm.id}"><span>${lm.name_bn} <span style="color:var(--muted); font-weight:500;">(${lm.name_en})</span></span><span class="area-tag">${lm.area}</span></li>`
      ).join('');
      list.hidden = false;
    };

    input.addEventListener('input', () => render(input.value));
    input.addEventListener('focus', () => { if (input.value.trim()) render(input.value); });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));

    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const lm = this.landmarkById[li.dataset.id];
      input.value = lm.name_bn;
      input.dataset.landmarkId = lm.id;
      onSelect(lm);
      list.hidden = true;
    });

    // Keep dataset in sync if the user types after picking (invalidate selection)
    input.addEventListener('input', () => {
      const lm = this.landmarks.find(l => l.name_bn === input.value.trim() || l.name_en.toLowerCase() === input.value.trim().toLowerCase());
      if (lm) { input.dataset.landmarkId = lm.id; onSelect(lm); }
      else { delete input.dataset.landmarkId; onSelect(null); }
    });
  },

  swapFields(fromPrefix, toPrefix, isBus = false) {
    const fromInput = document.getElementById(`${fromPrefix}-input`);
    const toInput = document.getElementById(`${toPrefix}-input`);
    [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
    [fromInput.dataset.landmarkId, toInput.dataset.landmarkId] = [toInput.dataset.landmarkId, fromInput.dataset.landmarkId];
    if (isBus) {
      [this.busSelected.from, this.busSelected.to] = [this.busSelected.to, this.busSelected.from];
    } else {
      [this.selected.from, this.selected.to] = [this.selected.to, this.selected.from];
    }
  },

  /* ---------- fare estimation flow ---------- */
  async handleEstimate() {
    const from = this.selected.from;
    const to = this.selected.to;
    if (!from || !to) {
      this.toast('তালিকা থেকে দুটি জায়গা বেছে নিন');
      return;
    }
    if (from.id === to.id) {
      this.toast('শুরু এবং শেষ জায়গা একই হতে পারে না');
      return;
    }

    const vehicle = document.getElementById('vehicle-select').value;
    const rain = document.getElementById('rain-toggle').checked;

    const straightLineKm = Haversine.distanceKm(from.lat, from.lng, to.lat, to.lng);
    const formula = FareEstimator.formulaEstimate({ straightLineKm, detourFactor: this.detourFactor, vehicle, rain });

    const routeKey = CrowdData.routeKey(from.id, to.id);
    const logs = await DB.getLogsByRouteKey(routeKey);
    const communityAvg = CrowdData.weightedAverageFare(logs);
    const confidence = CrowdData.confidenceTier(logs.length);
    const blended = CrowdData.blend(formula.total, communityAvg, logs.length);
    const range = FareEstimator.fairRange(blended);

    this.lastEstimate = {
      from, to, vehicle, rain, straightLineKm, formula, routeKey,
      communityAvg, confidence, blended, range, logsCount: logs.length
    };

    this.renderResult();
    await DB.touchFrequentRoute(routeKey, {
      fromId: from.id, toId: to.id, fromLabel: from.name_bn, toLabel: to.name_bn
    });
    this.renderFrequentRoutes();

    document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  renderResult() {
    const e = this.lastEstimate;
    document.getElementById('result').hidden = false;
    document.getElementById('log-panel').hidden = true;
    document.getElementById('bargain-line').hidden = true;

    document.getElementById('fare-low').textContent = e.range.low;
    document.getElementById('fare-high').textContent = e.range.high;

    const badge = document.getElementById('confidence-badge');
    const labels = {
      none: 'শুধু অনুমান (কোনো রিয়েল ডেটা নেই)',
      low: 'কম আস্থা — মাত্র কিছু লগ আছে',
      medium: 'মাঝারি আস্থা',
      high: 'উচ্চ আস্থা — অনেক রিয়েল রাইড ডেটা'
    };
    badge.textContent = `${labels[e.confidence]} · ${e.logsCount} টি লগ`;
    badge.className = 'confidence-badge ' + e.confidence;

    document.getElementById('detail-distance').textContent =
      `${e.formula.roadKm.toFixed(1)} কিমি (সরলরেখা ${e.straightLineKm.toFixed(1)} কিমি × ${this.detourFactor.toFixed(2)})`;
    document.getElementById('detail-rate').textContent = `৳${e.formula.base} + ৳${e.formula.perKm}/কিমি`;

    const surgeRow = document.getElementById('surge-row');
    if (e.formula.isPeak) {
      surgeRow.hidden = false;
      document.getElementById('detail-surge').textContent = `+৳${Math.round(e.formula.surgeAmount)} (ব্যস্ত সময়)`;
    } else surgeRow.hidden = true;

    const rainRow = document.getElementById('rain-row');
    if (e.rain) {
      rainRow.hidden = false;
      document.getElementById('detail-rain').textContent = `+৳${Math.round(e.formula.rainAmount)}`;
    } else rainRow.hidden = true;

    const communityRow = document.getElementById('community-row');
    if (e.communityAvg != null) {
      communityRow.hidden = false;
      document.getElementById('detail-community').textContent = `৳${Math.round(e.communityAvg)} (${e.logsCount} টি লগ থেকে)`;
    } else communityRow.hidden = true;

    document.getElementById('log-route-hint').textContent = `${e.from.name_bn} → ${e.to.name_bn}`;
  },

  showBargainLine() {
    const e = this.lastEstimate;
    if (!e) return;
    const line = document.getElementById('bargain-line');
    line.textContent = `বলুন: "ভাই, এই রাস্তায় সাধারণত ৳${e.range.low}-৳${e.range.high} লাগে, আমি ৳${e.range.low} দিতে পারি।"`;
    line.hidden = false;
  },

  /* ---------- log actual fare ---------- */
  openLogPanel() {
    document.getElementById('log-panel').hidden = false;
    document.getElementById('paid-input').value = '';
    document.getElementById('paid-input').focus();
    document.getElementById('log-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
  closeLogPanel() {
    document.getElementById('log-panel').hidden = true;
  },
  async submitFareLog() {
    const e = this.lastEstimate;
    const paid = Number(document.getElementById('paid-input').value);
    if (!e || !paid || paid <= 0) {
      this.toast('একটি সঠিক ভাড়ার পরিমাণ লিখুন');
      return;
    }
    await DB.addFareLog({
      routeKey: e.routeKey,
      fromId: e.from.id, toId: e.to.id,
      fromLabel: e.from.name_bn, toLabel: e.to.name_bn,
      distanceKm: e.straightLineKm,
      fareTaka: paid,
      vehicle: e.vehicle,
      rain: e.rain,
      timestamp: Date.now()
    });
    // Recalculate the learned detour factor now that we have one more data point.
    this.detourFactor = await CrowdData.recalculateDetourFactor();

    this.closeLogPanel();
    this.toast('ধন্যবাদ! আপনার ভাড়া সংরক্ষণ করা হয়েছে।');
    this.renderHistoryTab();
  },

  /* ---------- frequent routes ---------- */
  async renderFrequentRoutes() {
    const rows = await DB.getFrequentRoutes(6);
    const wrap = document.getElementById('frequent-wrap');
    const list = document.getElementById('frequent-list');
    if (!rows.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    list.innerHTML = rows.map(r =>
      `<button type="button" class="chip" data-from="${r.fromId}" data-to="${r.toId}">${r.fromLabel} → ${r.toLabel}</button>`
    ).join('');
    list.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const fromLm = this.landmarkById[chip.dataset.from];
        const toLm = this.landmarkById[chip.dataset.to];
        if (!fromLm || !toLm) return;
        document.getElementById('from-input').value = fromLm.name_bn;
        document.getElementById('to-input').value = toLm.name_bn;
        this.selected.from = fromLm;
        this.selected.to = toLm;
        this.handleEstimate();
      });
    });
  },

  /* ---------- bus search ---------- */
  handleBusSearch() {
    const from = this.busSelected.from;
    const to = this.busSelected.to;
    const container = document.getElementById('bus-results');
    if (!from || !to) {
      this.toast('তালিকা থেকে দুটি জায়গা বেছে নিন');
      return;
    }
    const matches = BusRoutes.findBetween(from.id, to.id);
    if (!matches.length) {
      container.innerHTML = `<div class="card"><p class="hint-text" style="margin:0;">এই দুটি জায়গার মধ্যে সরাসরি কোনো বাস রুট পাওয়া যায়নি এই তালিকায়। রিকশা/সিএনজি অপশন দেখতে পারেন, অথবা এক জায়গা বদলে চেষ্টা করুন।</p></div>`;
      return;
    }
    container.innerHTML = matches.map(m => {
      const stopsHtml = m.route.stops.map((stopId, i) => {
        const lm = this.landmarkById[stopId];
        const isMatch = i === m.iFrom || i === m.iTo;
        return `<span class="bus-stop${isMatch ? ' match' : ''}">${lm ? lm.name_bn : stopId}</span>`;
      }).join('<span class="bus-stop-arrow">→</span>');
      return `<div class="bus-route-card">
        <div class="bus-route-head">
          <span class="bus-route-no">${m.route.route_no}</span>
          <span class="bus-route-operator">${m.route.operator}${m.forward ? '' : ' (উল্টো দিকে)'}</span>
        </div>
        <div class="bus-stop-strip">${stopsHtml}</div>
      </div>`;
    }).join('');
  },

  /* ---------- history tab ---------- */
  async renderHistoryTab() {
    const logs = (await DB.getAllFareLogs()).sort((a, b) => b.timestamp - a.timestamp);
    document.getElementById('stat-logs').textContent = logs.length;
    const routeSet = new Set(logs.map(l => l.routeKey));
    document.getElementById('stat-routes').textContent = routeSet.size;
    const detourSample = await DB.getSetting('detourSampleCount', 0);
    document.getElementById('stat-detour').textContent = detourSample > 0 ? this.detourFactor.toFixed(2) : '—';

    const list = document.getElementById('history-list');
    if (!logs.length) {
      list.innerHTML = '<li class="empty-state">এখনো কোনো ভাড়া লগ করা হয়নি।</li>';
      return;
    }
    list.innerHTML = logs.slice(0, 30).map(l => {
      const d = new Date(l.timestamp);
      const dateStr = d.toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' });
      const vLabel = CONFIG.RATE_TABLE[l.vehicle] ? CONFIG.RATE_TABLE[l.vehicle].label : l.vehicle;
      return `<li>
        <div>
          <div class="history-route">${l.fromLabel} → ${l.toLabel}</div>
          <div class="history-meta">${dateStr} · ${vLabel}${l.rain ? ' · 🌧️' : ''}</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span class="history-fare">৳${l.fareTaka}</span>
          <button class="history-del" data-id="${l.id}" title="মুছে ফেলুন" aria-label="মুছে ফেলুন">✕</button>
        </div>
      </li>`;
    }).join('');

    list.querySelectorAll('.history-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        await DB.deleteFareLog(Number(btn.dataset.id));
        this.detourFactor = await CrowdData.recalculateDetourFactor();
        this.renderHistoryTab();
      });
    });
  },

  /* ---------- toast ---------- */
  toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
