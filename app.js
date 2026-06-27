const DB_NAME = "pachislo-lite";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const SNAPSHOT_ID = "main";

const appState = {
  records: [],
  machines: [],
  index: new Map(),
  selectedMachine: "",
  selectedUnitKey: "",
  metadata: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function text(value) {
  return value === undefined || value === null || value === "" ? "-" : String(value);
}

function esc(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function number(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return text(value);
  return n.toLocaleString("ja-JP", { maximumFractionDigits: digits });
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${number(n, 1)}%` : "-";
}

function odds(avgStart) {
  const n = Number(avgStart);
  return Number.isFinite(n) && n > 0 ? `1/${number(n, 1)}` : "-";
}

function toInt(value, fallback = 0) {
  const match = String(value ?? "").replaceAll(",", "").match(/-?\d+/);
  if (!match) return fallback;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, digits = 1) {
  if (!value) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function unitNumber(value) {
  return toInt(value, 0);
}

function dashLike(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  const normalized = raw.normalize("NFKC").replace(/[ー－−―‐]/g, "-").trim();
  return /^-+$/.test(normalized);
}

function compactUnitLabel(value) {
  const label = String(value ?? "").replace(/台番/g, "").replace(/\s+/g, "").trim();
  return label || text(value);
}

function isNoHitTerminal(record) {
  return Boolean(record.terminal) || (toInt(record.hitNo, 0) <= 0 && dashLike(record.time) && dashLike(record.payout));
}

function hitRecords(records) {
  return records.filter((record) => !isNoHitTerminal(record));
}

function currentChanceThreshold() {
  const input = $("#chanceThresholdInput");
  return Math.max(1, toInt(input?.value, 157));
}

function normalHitRecords(records, chanceThreshold) {
  return hitRecords(records).filter((record) => !isSpecial(record, chanceThreshold));
}

function unitProbabilityStats(records, chanceThreshold) {
  const normalHits = normalHitRecords(records, chanceThreshold);
  const terminalStarts = records.filter((record) => isNoHitTerminal(record)).map((record) => record.start);
  const totalStart = sum(normalHits.map((record) => record.start)) + sum(terminalStarts);
  const avgStart = normalHits.length ? totalStart / normalHits.length : 0;
  return {
    avgStart,
    normalHitCount: normalHits.length,
    terminalCount: terminalStarts.length,
    totalStart,
  };
}

function confidence(sampleCount) {
  if (sampleCount >= 80) return "高";
  if (sampleCount >= 25) return "中";
  return "低";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSnapshot(snapshot) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ id: SNAPSHOT_ID, ...snapshot });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadSnapshot() {
  const db = await openDb();
  const snapshot = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(SNAPSHOT_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return snapshot;
}

async function clearSnapshot() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(SNAPSHOT_ID);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(textValue || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim() !== "")) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => header.trim());
  return rows
    .filter((values) => values.some((value) => String(value).trim() !== ""))
    .map((values) => {
      const item = {};
      headers.forEach((header, index) => {
        item[header] = values[index] ?? "";
      });
      return item;
    });
}

function readColumn(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  const normalizedMap = new Map(Object.keys(row).map((key) => [normalize(key), key]));
  for (const key of keys) {
    const actual = normalizedMap.get(normalize(key));
    if (actual && String(row[actual]).trim() !== "") return row[actual];
  }
  return "";
}

function parseChance(row) {
  const raw = String(readColumn(row, ["is_chance_hit", "chance", "確変", "確変判定", "状態"]) || "").trim().toLowerCase();
  if (!raw) return { known: false, value: false };
  if (["1", "true", "yes", "y", "確変", "st", "rush", "チャンス", "赤"].some((token) => raw.includes(token))) {
    return { known: true, value: true };
  }
  if (["0", "false", "no", "n", "通常", "初当"].some((token) => raw.includes(token))) {
    return { known: true, value: false };
  }
  return { known: false, value: false };
}

function parseInputData(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.records)) return parsed.records;
    if (Array.isArray(parsed.rows)) return parsed.rows;
    throw new Error("JSON内に records または rows 配列が見つかりません。");
  }
  return parseCsv(trimmed);
}

function normalizeRows(rows) {
  const dedupe = new Set();
  const records = [];
  for (const row of rows) {
    const machine = String(readColumn(row, ["machine_name", "機種", "機種名", "model"]) || "").trim();
    const unitLabel = String(readColumn(row, ["unit_label", "台番", "台番号", "table"]) || "").trim();
    const date = String(readColumn(row, ["history_date", "history_day", "日付", "date"]) || "").trim();
    const start = toInt(readColumn(row, ["スタート", "start_count", "回転", "回転数", "games"]), 0);
    if (!machine || !unitLabel || start <= 0) continue;

    const hitNo = toInt(readColumn(row, ["大当り回数", "hit_count", "当り", "当たり番号"]), 0);
    const time = String(readColumn(row, ["時間", "hit_time", "時刻"]) || "").trim();
    const rate = String(readColumn(row, ["rate_name", "レート"]) || "").trim();
    const payout = String(readColumn(row, ["獲得数（継続数）", "獲得数 （継続数）", "payout", "出玉"]) || "").trim();
    const chance = parseChance(row);
    const terminal = hitNo <= 0 && dashLike(time) && dashLike(payout);
    const key = [machine, unitLabel, date, hitNo, time, start, payout].join("\u0000");
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    records.push({
      machine,
      rate,
      unitLabel,
      unitNo: unitNumber(unitLabel),
      date,
      hitNo,
      time,
      start,
      payout,
      terminal,
      chanceKnown: chance.known,
      chance: chance.value,
    });
  }
  return records;
}

function machineLabel(record) {
  return record.rate ? `${record.machine} / ${record.rate}` : record.machine;
}

function buildIndex(records) {
  const index = new Map();
  for (const record of records) {
    const label = machineLabel(record);
    if (!index.has(label)) index.set(label, new Map());
    const unitKey = `${record.unitNo || 999999}:${record.unitLabel}`;
    const units = index.get(label);
    if (!units.has(unitKey)) units.set(unitKey, []);
    units.get(unitKey).push(record);
  }
  for (const units of index.values()) {
    for (const group of units.values()) {
      group.sort((a, b) => {
        const dateDiff = String(a.date).localeCompare(String(b.date));
        if (dateDiff) return dateDiff;
        if (a.hitNo !== b.hitNo) return a.hitNo - b.hitNo;
        return a.start - b.start;
      });
    }
  }
  appState.index = index;
  appState.machines = Array.from(index.keys()).sort((a, b) => a.localeCompare(b, "ja"));
  appState.selectedMachine = appState.selectedMachine && index.has(appState.selectedMachine)
    ? appState.selectedMachine
    : appState.machines[0] || "";
  const units = appState.index.get(appState.selectedMachine) || new Map();
  if (!appState.selectedUnitKey || !units.has(appState.selectedUnitKey)) {
    appState.selectedUnitKey = units.keys().next().value || "";
  }
}

function setData(records, metadata) {
  appState.records = records;
  appState.metadata = metadata;
  buildIndex(records);
  renderSelectors();
  renderStatus();
  analyzeAndRender();
}

function currentUnits() {
  return appState.index.get(appState.selectedMachine) || new Map();
}

function unitDisplay(unitKey, records) {
  const first = records[0] || {};
  const stats = unitProbabilityStats(records, currentChanceThreshold());
  return {
    key: unitKey,
    label: first.unitLabel || unitKey,
    unitNo: first.unitNo || 0,
    hits: stats.normalHitCount,
    terminalCount: stats.terminalCount,
    totalStart: stats.totalStart,
    avgStart: stats.avgStart,
  };
}

function sortedUnitDisplays() {
  return Array.from(currentUnits().entries())
    .map(([key, records]) => unitDisplay(key, records))
    .sort((a, b) => (a.unitNo || 999999) - (b.unitNo || 999999) || a.label.localeCompare(b.label, "ja"));
}

function pickUnitRecords() {
  const units = currentUnits();
  if (!units.size) return [];
  if (!appState.selectedUnitKey || !units.has(appState.selectedUnitKey)) {
    appState.selectedUnitKey = units.keys().next().value || "";
  }
  return units.get(appState.selectedUnitKey) || [];
}

function isSpecial(record, chanceThreshold) {
  if (isNoHitTerminal(record)) return false;
  if (record.hitNo === 1) return false;
  if (record.chanceKnown) return Boolean(record.chance);
  return record.start > 0 && record.start <= chanceThreshold;
}

function probability(records, currentStart, targetStart, chanceThreshold, includeSpecial) {
  const scoped = includeSpecial ? records : records.filter((record) => isNoHitTerminal(record) || !isSpecial(record, chanceThreshold));
  const hitScoped = scoped.filter((record) => !isNoHitTerminal(record));
  const terminalScoped = scoped.filter((record) => isNoHitTerminal(record));
  const reachedHits = hitScoped.filter((record) => record.start > currentStart);
  const hits = reachedHits.filter((record) => record.start <= targetStart);
  const terminalNoHits = terminalScoped.filter((record) => record.start >= targetStart);
  const terminalPartial = terminalScoped.filter((record) => record.start > currentStart && record.start < targetStart);
  const reachedCount = reachedHits.length + terminalNoHits.length;
  const remaining = reachedHits.map((record) => record.start - currentStart);
  const rate = reachedCount ? (hits.length / reachedCount) * 100 : 0;
  return {
    rate: round(rate),
    hitCount: hits.length,
    reachedCount,
    noHitCount: terminalNoHits.length,
    partialNoHitCount: terminalPartial.length,
    avgRemaining: round(mean(remaining)),
    medianRemaining: round(median(remaining)),
    confidence: confidence(reachedCount),
  };
}

function chainMetrics(records, chanceThreshold) {
  const hits = hitRecords(records);
  const byDate = new Map();
  for (const record of hits) {
    const key = record.date || "unknown";
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(record);
  }
  const chains = [];
  for (const group of byDate.values()) {
    const ordered = [...group].sort((a, b) => {
      if (a.hitNo !== b.hitNo) return a.hitNo - b.hitNo;
      return a.start - b.start;
    });
    let current = 0;
    for (const record of ordered) {
      if (current > 0 && isSpecial(record, chanceThreshold)) {
        current += 1;
      } else {
        if (current > 0) chains.push(current);
        current = 1;
      }
    }
    if (current > 0) chains.push(current);
  }
  const totalHits = chains.reduce((sum, value) => sum + value, 0);
  const chainHits = chains.reduce((sum, value) => sum + Math.max(0, value - 1), 0);
  return {
    sequenceCount: chains.length,
    avgChain: round(mean(chains), 2),
    maxChain: chains.length ? Math.max(...chains) : 0,
    chainHitRate: round(totalHits ? (chainHits / totalHits) * 100 : 0),
  };
}

function trend(records, recentDays) {
  const dates = Array.from(new Set(records.map((record) => record.date).filter(Boolean))).sort();
  const recentSet = new Set(dates.slice(-recentDays));
  const hits = hitRecords(records);
  const longStarts = hits.map((record) => record.start);
  const recentStarts = hits.filter((record) => recentSet.has(record.date)).map((record) => record.start);
  const longAvg = mean(longStarts);
  const recentAvg = mean(recentStarts);
  let label = "判定不足";
  let tone = "info";
  if (recentStarts.length >= 3 && longAvg > 0) {
    if (recentAvg <= longAvg * 0.85) {
      label = "最近好調";
      tone = "ok";
    } else if (recentAvg >= longAvg * 1.15) {
      label = "最近重い";
      tone = "warn";
    } else {
      label = "通常並み";
      tone = "info";
    }
  }
  return {
    label,
    tone,
    longAvg: round(longAvg),
    recentAvg: round(recentAvg),
    recentCount: recentStarts.length,
    days: dates.length,
    dateMin: dates[0] || "",
    dateMax: dates[dates.length - 1] || "",
  };
}

function credibility(records, reachedCount) {
  const dates = new Set(records.map((record) => record.date).filter(Boolean));
  const hits = hitRecords(records);
  const known = hits.filter((record) => record.chanceKnown).length;
  const coverage = hits.length ? (known / hits.length) * 100 : 0;
  const score = Math.min(50, reachedCount) * 1.0 + Math.min(10, dates.size) * 3 + Math.min(20, coverage / 5);
  let label = "低";
  if (score >= 75) label = "高";
  else if (score >= 45) label = "中";
  return {
    label,
    score: round(Math.min(100, score)),
    days: dates.size,
    chanceCoverage: round(coverage),
    reasons: [`到達${reachedCount}件`, `履歴${dates.size}日`, `確変判定${round(coverage)}%`],
  };
}

function riskReturn(allProb, chains, cred, tr) {
  const hitRate = allProb.rate || 0;
  const avgChain = Math.max(1, chains.avgChain || 1);
  const expected = (hitRate / 100) * avgChain;
  let multiplier = 1;
  if (tr.label === "最近好調") multiplier = 1.08;
  if (tr.label === "最近重い") multiplier = 0.92;
  if (cred.label === "低") multiplier *= 0.75;
  const score = expected * multiplier;
  let decision = "見送り寄り";
  let tone = "bad";
  if (hitRate >= 35 && score >= 0.65 && cred.label !== "低") {
    decision = "強め候補";
    tone = "ok";
  } else if (hitRate >= 20 && score >= 0.35) {
    decision = "候補";
    tone = "info";
  } else if (hitRate >= 12) {
    decision = "要確認";
    tone = "warn";
  }
  return {
    decision,
    tone,
    expected: round(expected, 2),
    risk: hitRate >= 35 ? "低" : hitRate >= 20 ? "中" : "高",
    ret: chains.avgChain >= 3 ? "高" : chains.avgChain >= 2 ? "中" : "低",
  };
}

function analyze(records, options) {
  const currentStart = Math.max(0, toInt(options.currentStart, 0));
  const rangeSize = Math.max(10, toInt(options.rangeSize, 100));
  const targetStart = currentStart + rangeSize;
  const chanceThreshold = Math.max(1, toInt(options.chanceThreshold, 157));
  const recentDays = Math.max(1, Math.min(14, toInt(options.recentDays, 3)));
  const allProb = probability(records, currentStart, targetStart, chanceThreshold, true);
  const normalProb = probability(records, currentStart, targetStart, chanceThreshold, false);
  const chains = chainMetrics(records, chanceThreshold);
  const tr = trend(records, recentDays);
  const cred = credibility(records, allProb.reachedCount);
  const rr = riskReturn(allProb, chains, cred, tr);
  const ranges = [50, 100, 200, 300].map((range) => {
    const p = probability(records, currentStart, currentStart + range, chanceThreshold, true);
    const n = probability(records, currentStart, currentStart + range, chanceThreshold, false);
    return { range, target: currentStart + range, all: p, normal: n };
  });
  return { currentStart, rangeSize, targetStart, allProb, normalProb, chains, tr, cred, rr, ranges };
}

function renderSelectors() {
  $("#machineSelect").innerHTML = appState.machines.map((machine) => `<option value="${esc(machine)}">${esc(machine)}</option>`).join("");
  $("#machineSelect").value = appState.selectedMachine;
  const units = sortedUnitDisplays();
  if (!appState.selectedUnitKey && units[0]) appState.selectedUnitKey = units[0].key;
  renderUnitPicker(units);
}

function renderStatus() {
  if (!appState.records.length) {
    $("#dataStatus").textContent = "データ未読込";
    return;
  }
  const meta = appState.metadata || {};
  $("#dataStatus").textContent = `${number(appState.records.length)}件 / ${number(appState.machines.length)}機種 / ${meta.importedAt || ""}`;
}

function toneClass(tone) {
  return ["ok", "info", "warn", "bad"].includes(tone) ? tone : "";
}

function metric(label, value) {
  return `<div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function renderUnitPicker(units) {
  const picker = $("#unitPicker");
  if (!picker) return;
  if (!units.length) {
    picker.innerHTML = `<div class="note">表示できる台番がありません。</div>`;
    return;
  }
  const machineStats = unitProbabilityStats(Array.from(currentUnits().values()).flat(), currentChanceThreshold());
  picker.innerHTML = units
    .map((unit) => {
      const selected = String(unit.key) === String(appState.selectedUnitKey);
      const tone = unitTone(unit, machineStats);
      return `
        <button class="unit-button ${tone} ${selected ? "selected" : ""}" type="button" data-unit-key="${esc(unit.key)}">
          <strong>${esc(compactUnitLabel(unit.label))}</strong>
          <span>${odds(unit.avgStart)} / ${number(unit.hits)}件</span>
        </button>
      `;
    })
    .join("");
}

function cleanCurrentStart(value) {
  const digits = String(value ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 5);
  return digits || "0";
}

function setCurrentStart(value) {
  $("#currentStartInput").value = cleanCurrentStart(value);
  analyzeAndRender();
}

function appendCurrentStart(part) {
  const current = cleanCurrentStart($("#currentStartInput").value);
  setCurrentStart(current === "0" ? part : `${current}${part}`);
}

function unitTone(unit, machineStats) {
  if (!unit || unit.hits < 3 || !unit.avgStart || !machineStats?.avgStart) return "";
  const ratio = unit.avgStart / machineStats.avgStart;
  if (ratio <= 0.9) return "good";
  if (ratio >= 1.1) return "bad";
  return "neutral";
}

function analyzeAndRender() {
  const records = pickUnitRecords();
  if (!records.length) {
    $("#decisionText").textContent = "データなし";
    $("#decisionText").className = "";
    $("#allRateText").textContent = "-";
    $("#rangeText").textContent = "-";
    $("#metrics").innerHTML = "";
    $("#notes").innerHTML = `<div class="note">データを取り込むか、存在する台番を入力してください。</div>`;
    $("#rangeCards").innerHTML = "";
    $("#unitSummary").textContent = "-";
    return;
  }
  const result = analyze(records, {
    currentStart: $("#currentStartInput").value,
    rangeSize: $("#rangeInput").value,
    chanceThreshold: $("#chanceThresholdInput").value,
    recentDays: $("#recentDaysInput").value,
  });
  const first = records[0];
  $("#decisionText").textContent = result.rr.decision;
  $("#decisionText").className = toneClass(result.rr.tone);
  $("#allRateText").textContent = pct(result.allProb.rate);
  $("#rangeText").textContent = `${number(result.currentStart)}→${number(result.targetStart)}回転`;
  $("#unitSummary").textContent = `${compactUnitLabel(first.unitLabel)} / 当たり${number(hitRecords(records).length)}件`;
  $("#metrics").innerHTML = [
    metric("当たり件数", `${number(result.allProb.hitCount)} / ${number(result.allProb.reachedCount)}`),
    metric("初当りのみ", pct(result.normalProb.rate)),
    metric("信憑性", `${result.cred.label} (${number(result.cred.score)}点)`),
    metric("平均連荘", `${number(result.chains.avgChain, 2)}連`),
    metric("期待連", `${number(result.rr.expected, 2)}連`),
    metric("残り平均", `${number(result.allProb.avgRemaining)}回転`),
  ].join("");
  const noHitNote = result.allProb.noHitCount
    ? ` / 終了回転${number(result.allProb.noHitCount)}件を未当たりとして分母に含む`
    : "";
  const partialNote = result.allProb.partialNoHitCount
    ? ` / 目標未到達の終了回転${number(result.allProb.partialNoHitCount)}件は除外`
    : "";
  $("#notes").innerHTML = [
    `<div class="note"><strong>${esc(result.tr.label)}</strong><br>直近平均 ${number(result.tr.recentAvg)}回転 / 長期平均 ${number(result.tr.longAvg)}回転</div>`,
    `<div class="note"><strong>リスク ${esc(result.rr.risk)} / リターン ${esc(result.rr.ret)}</strong><br>${esc(result.cred.reasons.join(" / ") + noHitNote + partialNote)}</div>`,
  ].join("");
  $("#rangeCards").innerHTML = result.ranges.map((item) => `
    <button class="range-card" type="button" data-range="${item.range}">
      <span>+${number(item.range)} / ${number(item.target)}回転まで</span>
      <strong>${pct(item.all.rate)}</strong>
      <small>初当り ${pct(item.normal.rate)} / ${number(item.all.hitCount)}件 / 到達${number(item.all.reachedCount)}件 / ${esc(item.all.confidence)}</small>
    </button>
  `).join("");
  $$(".range-row button").forEach((button) => {
    button.classList.toggle("selected", Number(button.dataset.range) === Number($("#rangeInput").value));
  });
}

async function importText(rawText, sourceName) {
  const rows = parseInputData(rawText);
  const records = normalizeRows(rows);
  if (!records.length) {
    throw new Error("有効な台履歴を読み取れませんでした。列名とCSV内容を確認してください。");
  }
  const metadata = {
    sourceName: sourceName || "manual",
    importedAt: new Date().toLocaleString("ja-JP", { hour12: false }),
    rawRows: rows.length,
  };
  await saveSnapshot({ records, metadata });
  setData(records, metadata);
  $("#importMessage").textContent = `${number(records.length)}件を保存しました。`;
  showAnalyze();
}

function showImport() {
  $("#analyzeView").classList.add("hidden");
  $("#importView").classList.remove("hidden");
}

function showAnalyze() {
  $("#importView").classList.add("hidden");
  $("#analyzeView").classList.remove("hidden");
}

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    metadata: appState.metadata,
    records: appState.records,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "pachislo-lite-data.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bindEvents() {
  $("#showImportBtn").addEventListener("click", showImport);
  $("#backBtn").addEventListener("click", showAnalyze);
  $("#machineSelect").addEventListener("change", () => {
    appState.selectedMachine = $("#machineSelect").value;
    appState.selectedUnitKey = "";
    renderSelectors();
    analyzeAndRender();
  });
  $("#unitPicker").addEventListener("click", (event) => {
    const button = event.target.closest("[data-unit-key]");
    if (!button) return;
    appState.selectedUnitKey = button.dataset.unitKey || "";
    renderUnitPicker(sortedUnitDisplays());
    analyzeAndRender();
  });
  ["#rangeInput", "#chanceThresholdInput", "#recentDaysInput"].forEach((selector) => {
    const handler = () => {
      if (selector === "#chanceThresholdInput") renderUnitPicker(sortedUnitDisplays());
      analyzeAndRender();
    };
    $(selector).addEventListener("input", handler);
    $(selector).addEventListener("change", handler);
  });
  $("#currentStartInput").addEventListener("click", () => {
    $("#currentStartInput").blur();
  });
  $(".keypad").addEventListener("click", (event) => {
    const keyButton = event.target.closest("[data-current-key]");
    if (keyButton) {
      appendCurrentStart(keyButton.dataset.currentKey || "");
      return;
    }
    const actionButton = event.target.closest("[data-current-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.currentAction;
    if (action === "clear") {
      setCurrentStart("0");
    } else if (action === "back") {
      const current = cleanCurrentStart($("#currentStartInput").value);
      setCurrentStart(current.length > 1 ? current.slice(0, -1) : "0");
    }
  });
  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    $("#rangeInput").value = button.dataset.range;
    analyzeAndRender();
  });
  $("#importBtn").addEventListener("click", async () => {
    try {
      const file = $("#fileInput").files[0];
      const pasted = $("#pasteInput").value.trim();
      if (file) {
        await importText(await file.text(), file.name);
      } else {
        await importText(pasted, "paste");
      }
    } catch (error) {
      $("#importMessage").textContent = `取り込み失敗: ${error.message}`;
    }
  });
  $("#exportBtn").addEventListener("click", exportData);
  $("#clearBtn").addEventListener("click", async () => {
    if (!confirm("保存データをこのiPhoneから削除しますか？")) return;
    await clearSnapshot();
    setData([], null);
    $("#importMessage").textContent = "保存データを削除しました。";
    showImport();
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch {
    // Offline install is optional during local testing.
  }
}

async function init() {
  bindEvents();
  await registerServiceWorker();
  const snapshot = await loadSnapshot();
  if (snapshot && Array.isArray(snapshot.records) && snapshot.records.length) {
    setData(snapshot.records, snapshot.metadata || null);
    showAnalyze();
  } else {
    setData([], null);
    showImport();
  }
}

window.PachisloLite = {
  analyze,
  buildIndex,
  normalizeRows,
  parseCsv,
  parseInputData,
  probability,
};

init().catch((error) => {
  $("#dataStatus").textContent = "起動エラー";
  $("#importMessage").textContent = error.message;
  showImport();
});
