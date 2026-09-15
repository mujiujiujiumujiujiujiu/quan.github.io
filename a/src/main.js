import { BattleSimulation, WORLD } from './sim.js';
import { NativeWebGLRenderer } from './webgl.js';

const MAX_DEPLOYMENTS = 24;
const MIN_ZOOM = 0.42;
const MAX_ZOOM = 1.45;
const PLAYER_ZONE_RIGHT = 760;
const PLAYER_SAFE_MARGIN = 48;

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const formatClock = (seconds) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, '0')}:${String(safeSeconds % 60).padStart(2, '0')}`;
};

function makeElement(tag, className, text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

class TinyAudio {
  constructor() {
    this.context = null;
    this.enabled = true;
  }

  unlock() {
    if (!this.enabled) return;
    this.userGesture = true;
    try {
      if (!this.context) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          this.enabled = false;
          return;
        }
        this.context = new AudioContextClass();
      }
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    } catch (error) {
      this.enabled = false;
      this.context = null;
    }
  }

  blip(frequency = 360, duration = 0.07, type = 'sine', volume = 0.025) {
    if (!this.userGesture) return;
    this.unlock();
    if (!this.context) return;
    try {
      const now = this.context.currentTime;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(80, frequency * 0.72), now + duration);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gain);
      gain.connect(this.context.destination);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
    } catch (error) {
      this.enabled = false;
      this.context = null;
    }
  }

  event(tone) {
    if (!this.userGesture) return;
    const sounds = {
      skill: [620, 0.12, 'triangle', 0.035],
      reward: [780, 0.18, 'sine', 0.04],
      danger: [150, 0.16, 'sawtooth', 0.026],
      combat: [250, 0.04, 'square', 0.012],
      result: [510, 0.16, 'triangle', 0.03],
      info: [320, 0.05, 'sine', 0.014],
    };
    const [frequency, duration, type, volume] = sounds[tone] ?? sounds.info;
    this.blip(frequency, duration, type, volume);
  }
}

class MemeWarApp {
  constructor(unitsData, levelsData) {
    this.units = unitsData.units;
    this.unitsById = Object.fromEntries(this.units.map((unit) => [unit.id, unit]));
    this.levels = levelsData.levels;
    this.audio = new TinyAudio();
    this.canvas = $('#gameCanvas');
    this.worldLabels = $('#worldLabels');
    this.renderer = null;
    this.simulation = null;
    this.phase = 'prep';
    this.levelIndex = 0;
    this.level = this.levels[0];
    this.deployments = [];
    this.spent = 0;
    this.nextDeploymentId = 1;
    this.selectedUnitId = null;
    this.draggedDeployment = null;
    this.hoverWorld = null;
    this.cameraDrag = null;
    this.slowInput = false;
    this.paused = false;
    this.speed = 1;
    this.renderTime = 0;
    this.lastFrameTime = 0;
    this.resultShown = false;
    this.labelNodes = new Map();

    this.camera = { x: WORLD.width / 2, y: WORLD.height / 2, zoom: 0.72 };
    this.elements = {
      app: $('#app'),
      phaseLabel: $('#phaseLabel'),
      budgetLabel: $('#budgetLabel'),
      levelSelect: $('#levelSelect'),
      pauseButton: $('#pauseButton'),
      startButton: $('#startButton'),
      resetButton: $('#resetButton'),
      prepGuide: $('#prepGuide'),
      battleGuide: $('#battleGuide'),
      levelTitle: $('#levelTitle'),
      levelSubtitle: $('#levelSubtitle'),
      levelNumber: $('#levelNumber'),
      levelTip: $('#levelTip'),
      waveReadout: $('#waveReadout'),
      battleClock: $('#battleClock'),
      playerCount: $('#playerCount'),
      enemyCount: $('#enemyCount'),
      battleProgress: $('#battleProgress'),
      eventLog: $('#eventLog'),
      speedReadout: $('#speedReadout'),
      unitList: $('#unitList'),
      deployedCount: $('#deployedCount'),
      resultOverlay: $('#resultOverlay'),
      resultCard: $('.result-card'),
      resultStamp: $('#resultStamp'),
      resultLevelName: $('#resultLevelName'),
      resultTitle: $('#resultTitle'),
      resultSummary: $('#resultSummary'),
      resultInitial: $('#resultInitial'),
      resultSpent: $('#resultSpent'),
      resultBonus: $('#resultBonus'),
      resultRemaining: $('#resultRemaining'),
      resultRating: $('#resultRating'),
      resultRatio: $('#resultRatio'),
      retryButton: $('#retryButton'),
      nextButton: $('#nextButton'),
      toast: $('#toast'),
      loading: $('#loading'),
      webglFallback: $('#webglFallback'),
    };
    this.toastTimer = null;
  }

  async init() {
    this.populateLevelPicker();
    this.populateUnitDock();
    this.bindEvents();
    this.updateLevelUi();

    try {
      this.renderer = new NativeWebGLRenderer(this.canvas);
      this.fitCamera();
    } catch (error) {
      console.error(error);
      this.elements.webglFallback.classList.remove('hidden');
      this.elements.loading.classList.add('hidden');
      this.elements.startButton.disabled = true;
      this.showToast('无法初始化 WebGL2，请打开浏览器硬件加速后刷新。');
      return;
    }

    try {
      await this.renderer.loadTexture('./assets/units-handdrawn-atlas.png');
    } catch (error) {
      this.showToast('手绘角色纹理加载失败，将使用几何占位。');
    }

    window.addEventListener('resize', () => this.renderer?.resize());
    this.elements.loading.classList.add('hidden');
    this.logEvent({ text: '战场加载完成。挑一张卡，然后把它放进左半场。', tone: 'info' });
    this.syncUi();
    window.requestAnimationFrame((time) => this.frame(time));
  }

  populateLevelPicker() {
    this.elements.levelSelect.replaceChildren();
    for (const [index, level] of this.levels.entries()) {
      const option = makeElement('option', '', `第 ${String(level.id).padStart(2, '0')} · ${level.name}`);
      option.value = String(index);
      this.elements.levelSelect.append(option);
    }
  }

  populateUnitDock() {
    const playableUnits = this.units
      .filter((unit) => !unit.enemyOnly)
      .sort((first, second) => second.price - first.price || first.name.localeCompare(second.name, 'zh'));
    this.elements.unitList.replaceChildren();
    for (const unit of playableUnits) {
      const card = makeElement('button', 'unit-card');
      card.type = 'button';
      card.dataset.unitId = unit.id;
      card.setAttribute('aria-label', `${unit.name}，${unit.price} 金，${unit.roleLabel}`);

      const top = makeElement('div', 'card-top');
      const glyph = makeElement('span', 'unit-glyph', unit.name.slice(0, 1));
      glyph.style.background = unit.color;
      if (Number.isInteger(unit.spriteIndex)) {
        const spriteColumn = unit.spriteIndex % 4;
        const spriteRow = Math.floor(unit.spriteIndex / 4);
        glyph.textContent = '';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.style.backgroundImage = "url('./assets/units-handdrawn-atlas.png')";
        glyph.style.backgroundSize = '400% 400%';
        glyph.style.backgroundPosition = `${spriteColumn * (100 / 3)}% ${spriteRow * (100 / 3)}%`;
      }
      const price = makeElement('span', 'unit-price', `${unit.price} 金`);
      top.append(glyph, price);

      const name = makeElement('div', 'unit-name', unit.name);
      const role = makeElement('div', 'unit-role', unit.roleLabel);
      const stats = makeElement('div', 'unit-stats');
      const hp = makeElement('span', '', `❤ ${unit.hp}`);
      const atk = makeElement('b', '', unit.role === 'deployable' ? '路障' : `⚔ ${unit.atk}`);
      stats.append(hp, atk);
      card.append(top, name, role, stats);
      card.addEventListener('click', () => this.selectUnit(unit.id));
      this.elements.unitList.append(card);
    }
    this.updateUnitCards();
  }

  bindEvents() {
    this.elements.startButton.addEventListener('click', () => this.startBattle());
    this.elements.pauseButton.addEventListener('click', () => this.togglePause());
    this.elements.resetButton.addEventListener('click', () => this.resetLevel(this.levelIndex));
    this.elements.retryButton.addEventListener('click', () => this.resetLevel(this.levelIndex));
    this.elements.nextButton.addEventListener('click', () => {
      if (this.levelIndex < this.levels.length - 1) this.resetLevel(this.levelIndex + 1);
      else this.resetLevel(this.levelIndex);
    });
    this.elements.levelSelect.addEventListener('change', (event) => {
      const index = Number.parseInt(event.target.value, 10);
      if (Number.isFinite(index)) this.resetLevel(index);
    });
    for (const button of document.querySelectorAll('.speed-button')) {
      button.addEventListener('click', () => this.setSpeed(Number(button.dataset.speed)));
    }

    this.canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (this.phase !== 'prep') return;
      const world = this.pointerToWorld(event);
      const deployment = this.findDeploymentAt(world.x, world.y);
      if (deployment) {
        this.removeDeployment(deployment);
        this.audio.blip(190, 0.06, 'square', 0.018);
      }
    });
    this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });

    window.addEventListener('keydown', (event) => {
      if (event.code === 'Space') {
        event.preventDefault();
        this.togglePause();
      }
      if (event.key === 'g' || event.key === 'G') this.slowInput = true;
      if (event.key === '1' || event.key === '2' || event.key === '4') this.setSpeed(Number(event.key));
      if (event.key === 'Escape') this.selectedUnitId = null;
    });
    window.addEventListener('keyup', (event) => {
      if (event.key === 'g' || event.key === 'G') this.slowInput = false;
    });
    window.addEventListener('blur', () => {
      this.slowInput = false;
      this.cameraDrag = null;
    });
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: true });
  }

  resetLevel(index = this.levelIndex) {
    this.levelIndex = clamp(index, 0, this.levels.length - 1);
    this.level = this.levels[this.levelIndex];
    this.phase = 'prep';
    this.deployments = [];
    this.spent = 0;
    this.nextDeploymentId = 1;
    this.selectedUnitId = null;
    this.draggedDeployment = null;
    this.cameraDrag = null;
    this.hoverWorld = null;
    this.simulation = null;
    this.paused = false;
    this.resultShown = false;
    this.camera = { x: WORLD.width / 2, y: WORLD.height / 2, zoom: 0.72 };
    this.fitCamera();
    this.elements.app.classList.remove('phase-battle', 'phase-result');
    this.elements.app.classList.add('phase-prep');
    this.elements.resultOverlay.classList.add('hidden');
    this.elements.levelSelect.value = String(this.levelIndex);
    this.elements.eventLog.replaceChildren();
    this.updateLevelUi();
    this.logEvent({ text: `第 ${this.level.id} 关已重置，等待你的解法。`, tone: 'info' });
    this.syncUi();
    this.audio.blip(280, 0.06, 'sine', 0.018);
  }

  updateLevelUi() {
    const level = this.level;
    this.elements.levelTitle.textContent = level.name;
    this.elements.levelSubtitle.textContent = level.subtitle;
    this.elements.levelNumber.textContent = String(level.id).padStart(2, '0');
    this.elements.levelTip.textContent = level.tip;
    this.elements.resultLevelName.textContent = level.name;
  }

  selectUnit(unitId) {
    if (this.phase !== 'prep') return;
    const unit = this.unitsById[unitId];
    if (!unit) return;
    if (this.budgetRemaining < unit.price) {
      this.showToast('预算不够了，换一张更便宜的卡。');
      this.audio.blip(150, 0.06, 'square', 0.018);
      return;
    }
    this.selectedUnitId = this.selectedUnitId === unitId ? null : unitId;
    this.updateUnitCards();
    this.audio.blip(this.selectedUnitId ? 500 : 230, 0.06, 'triangle', 0.02);
  }

  get budgetRemaining() {
    return Math.max(0, this.level.budget - this.spent);
  }

  get enemyPreviewUnits() {
    const result = [];
    let order = 0;
    for (const entry of this.level.enemies) {
      for (let index = 0; index < entry.count; index += 1) {
        const data = { ...this.unitsById[entry.unitId], ...(entry.overrides ?? {}) };
        const column = order % 3;
        const row = Math.floor(order / 3);
        result.push({
          id: `enemy-preview-${order}`,
          side: 'enemy',
          data,
          x: 1120 + column * 122 + (row % 2) * 36,
          y: 190 + row * 150 + (column % 2) * 28,
          hp: data.hp,
          maxHp: data.hp,
          alive: true,
          facing: Math.PI,
          status: {},
        });
        order += 1;
      }
    }
    return result;
  }

  startBattle() {
    if (this.phase !== 'prep') return;
    if (this.deployments.length === 0) {
      this.showToast('至少部署一个单位，再按开始战斗。');
      return;
    }
    this.phase = 'battle';
    this.paused = false;
    this.selectedUnitId = null;
    this.draggedDeployment = null;
    this.simulation = new BattleSimulation(this.unitsById, this.level, this.deployments, (event) => this.logEvent(event));
    this.simulation.start();
    this.elements.app.classList.remove('phase-prep');
    this.elements.app.classList.add('phase-battle');
    this.audio.blip(460, 0.12, 'triangle', 0.035);
    this.syncUi();
  }

  togglePause() {
    if (this.phase !== 'battle') return;
    this.paused = !this.paused;
    this.syncUi();
    this.audio.blip(this.paused ? 220 : 540, 0.07, 'sine', 0.02);
  }

  setSpeed(speed) {
    if (![1, 2, 4].includes(speed)) return;
    this.speed = speed;
    for (const button of document.querySelectorAll('.speed-button')) {
      button.classList.toggle('active', Number(button.dataset.speed) === speed);
    }
    this.syncUi();
  }

  onPointerDown(event) {
    this.audio.unlock();
    const world = this.pointerToWorld(event);
    if (this.phase === 'prep') {
      const existing = this.findDeploymentAt(world.x, world.y);
      if (existing) {
        this.draggedDeployment = { deployment: existing, pointerId: event.pointerId };
        this.selectedUnitId = existing.unitId;
        this.canvas.setPointerCapture?.(event.pointerId);
        this.updateUnitCards();
        return;
      }
      if (event.button === 0 && this.selectedUnitId) this.placeSelectedUnit(world.x, world.y);
      return;
    }

    if (this.phase === 'battle' || this.phase === 'result') {
      this.slowInput = event.button === 0 && this.phase === 'battle';
      this.cameraDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        cameraX: this.camera.x,
        cameraY: this.camera.y,
      };
      this.canvas.setPointerCapture?.(event.pointerId);
    }
  }

  onPointerMove(event) {
    const world = this.pointerToWorld(event);
    this.hoverWorld = world;
    if (this.phase === 'prep' && this.draggedDeployment?.pointerId === event.pointerId) {
      const deployment = this.draggedDeployment.deployment;
      const data = this.unitsById[deployment.unitId];
      deployment.x = clamp(world.x, WORLD.minX + PLAYER_SAFE_MARGIN, PLAYER_ZONE_RIGHT - data.radius);
      deployment.y = clamp(world.y, WORLD.minY + PLAYER_SAFE_MARGIN, WORLD.maxY - PLAYER_SAFE_MARGIN);
      return;
    }
    if (this.cameraDrag?.pointerId === event.pointerId) {
      const dx = (event.clientX - this.cameraDrag.startX) / this.camera.zoom;
      const dy = (event.clientY - this.cameraDrag.startY) / this.camera.zoom;
      this.camera.x = this.cameraDrag.cameraX - dx;
      this.camera.y = this.cameraDrag.cameraY - dy;
      this.clampCamera();
    }
  }

  onPointerUp(event) {
    if (this.draggedDeployment?.pointerId === event.pointerId) {
      this.draggedDeployment = null;
      return;
    }
    if (this.cameraDrag?.pointerId === event.pointerId) {
      this.cameraDrag = null;
    }
    if (event.button === 0) this.slowInput = false;
  }

  onWheel(event) {
    event.preventDefault();
    if (!this.renderer) return;
    const before = this.pointerToWorld(event);
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    this.camera.zoom = clamp(this.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.pointerToWorld(event);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
    this.clampCamera();
  }

  pointerToWorld(event) {
    const rect = this.canvas.getBoundingClientRect();
    return this.renderer
      ? this.renderer.screenToWorld(event.clientX - rect.left, event.clientY - rect.top)
      : { x: WORLD.width / 2, y: WORLD.height / 2 };
  }

  clampCamera() {
    if (!this.renderer) return;
    const halfWorldWidth = this.renderer.width / (2 * this.camera.zoom);
    const halfWorldHeight = this.renderer.height / (2 * this.camera.zoom);
    const minCameraX = halfWorldWidth >= WORLD.width / 2 ? WORLD.width / 2 : halfWorldWidth;
    const maxCameraX = halfWorldWidth >= WORLD.width / 2 ? WORLD.width / 2 : WORLD.width - halfWorldWidth;
    const minCameraY = halfWorldHeight >= WORLD.height / 2 ? WORLD.height / 2 : halfWorldHeight;
    const maxCameraY = halfWorldHeight >= WORLD.height / 2 ? WORLD.height / 2 : WORLD.height - halfWorldHeight;
    this.camera.x = clamp(this.camera.x, minCameraX, maxCameraX);
    this.camera.y = clamp(this.camera.y, minCameraY, maxCameraY);
  }

  fitCamera() {
    if (!this.renderer) return;
    this.camera.x = WORLD.width / 2;
    this.camera.y = WORLD.height / 2;
    this.camera.zoom = clamp(
      Math.min((this.renderer.width - 36) / WORLD.width, (this.renderer.height - 36) / WORLD.height),
      MIN_ZOOM,
      MAX_ZOOM,
    );
  }

  placeSelectedUnit(x, y) {
    const unit = this.unitsById[this.selectedUnitId];
    if (!unit) return;
    if (this.deployments.length >= MAX_DEPLOYMENTS) {
      this.showToast(`最多部署 ${MAX_DEPLOYMENTS} 个单位。`);
      return;
    }
    if (x > PLAYER_ZONE_RIGHT - unit.radius || x < WORLD.minX + PLAYER_SAFE_MARGIN || y < WORLD.minY + PLAYER_SAFE_MARGIN || y > WORLD.maxY - PLAYER_SAFE_MARGIN) {
      this.showToast('只能放在左侧部署区内。');
      return;
    }
    if (this.budgetRemaining < unit.price) {
      this.showToast('预算不够了，换一张更便宜的卡。');
      return;
    }
    const deployment = {
      id: `deployment-${this.nextDeploymentId++}`,
      unitId: unit.id,
      data: unit,
      x: clamp(x, WORLD.minX + PLAYER_SAFE_MARGIN, PLAYER_ZONE_RIGHT - unit.radius),
      y: clamp(y, WORLD.minY + PLAYER_SAFE_MARGIN, WORLD.maxY - PLAYER_SAFE_MARGIN),
    };
    this.deployments.push(deployment);
    this.spent += unit.price;
    this.audio.blip(610, 0.055, 'triangle', 0.018);
    this.syncUi();
  }

  findDeploymentAt(x, y) {
    let closest = null;
    let closestDistance = Infinity;
    for (const deployment of this.deployments) {
      const data = this.unitsById[deployment.unitId];
      const currentDistance = Math.hypot(deployment.x - x, deployment.y - y);
      if (currentDistance <= data.radius + 14 && currentDistance < closestDistance) {
        closest = deployment;
        closestDistance = currentDistance;
      }
    }
    return closest;
  }

  removeDeployment(deployment) {
    const data = this.unitsById[deployment.unitId];
    const index = this.deployments.indexOf(deployment);
    if (index < 0) return;
    this.deployments.splice(index, 1);
    this.spent = Math.max(0, this.spent - data.price);
    if (this.selectedUnitId === deployment.unitId) this.selectedUnitId = null;
    this.syncUi();
  }

  get battleUnits() {
    if (this.phase === 'prep') {
      const players = this.deployments.map((deployment) => {
        const data = this.unitsById[deployment.unitId];
        return {
          ...deployment,
          side: 'player',
          data,
          hp: data.hp,
          maxHp: data.hp,
          alive: true,
          facing: 0,
          status: {},
        };
      });
      return [...players, ...this.enemyPreviewUnits];
    }
    return this.simulation?.units ?? [];
  }

  logEvent(event) {
    if (!event?.text) return;
    const line = makeElement('div', `event ${event.tone ?? 'info'}`, event.text);
    this.elements.eventLog.prepend(line);
    while (this.elements.eventLog.children.length > 8) this.elements.eventLog.lastElementChild.remove();
    this.audio.event(event.tone);
  }

  showToast(text) {
    this.elements.toast.textContent = text;
    this.elements.toast.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.elements.toast.classList.remove('show'), 1900);
  }

  finishBattle() {
    if (this.resultShown || !this.simulation || this.simulation.phase !== 'result') return;
    this.resultShown = true;
    this.phase = 'result';
    this.paused = false;
    const won = this.simulation.outcome === 'win';
    const remaining = Math.max(0, this.level.budget - this.spent + this.simulation.goldBonus);
    const ratio = this.level.budget > 0 ? remaining / this.level.budget : 0;
    const rating = ratio >= 0.5 ? 'S' : ratio >= 0.35 ? 'A' : ratio >= 0.2 ? 'B' : ratio >= 0.05 ? 'C' : 'D';
    this.elements.resultCard.classList.toggle('lose', !won);
    this.elements.resultStamp.textContent = won ? 'VICTORY' : 'DEFEAT';
    this.elements.resultTitle.textContent = won ? '胜利' : '失败';
    this.elements.resultSummary.textContent = won
      ? `完成 ${this.simulation.totalWaves} 波战斗，战场留下了 ${this.simulation.playerCount} 名己方单位。`
      : '你的编队被清空了。换一个克制思路，再把部署点拉开一点。';
    this.elements.resultInitial.textContent = String(this.level.budget);
    this.elements.resultSpent.textContent = String(this.spent);
    this.elements.resultBonus.textContent = `+${this.simulation.goldBonus}`;
    this.elements.resultRemaining.textContent = String(remaining);
    this.elements.resultRating.textContent = won ? rating : '—';
    this.elements.resultRatio.textContent = won ? `${Math.round(ratio * 100)}% 预算留存` : '本局未完成';
    this.elements.nextButton.textContent = this.levelIndex < this.levels.length - 1 ? '下一关' : '再试一次';
    this.elements.resultOverlay.classList.remove('hidden');
    this.elements.app.classList.remove('phase-battle');
    this.elements.app.classList.add('phase-result');
    this.audio.event(won ? 'reward' : 'danger');
    this.syncUi();
  }

  syncUi() {
    const isPrep = this.phase === 'prep';
    const isBattle = this.phase === 'battle';
    const isResult = this.phase === 'result';
    const available = isPrep ? this.budgetRemaining : Math.max(0, this.level.budget - this.spent + (this.simulation?.goldBonus ?? 0));
    this.elements.phaseLabel.textContent = isPrep ? '准备部署' : isBattle ? (this.paused ? '战斗暂停' : '自动战斗') : '战斗结算';
    this.elements.budgetLabel.textContent = String(available);
    this.elements.startButton.classList.toggle('hidden', !isPrep);
    this.elements.pauseButton.classList.toggle('hidden', !isBattle);
    this.elements.pauseButton.textContent = this.paused ? '继续' : '暂停';
    this.elements.resetButton.textContent = isPrep ? '清空重摆' : '重新部署';
    this.elements.resetButton.disabled = false;
    this.elements.levelSelect.disabled = isBattle;
    this.elements.app.classList.toggle('phase-prep', isPrep);
    this.elements.app.classList.toggle('phase-battle', isBattle);
    this.elements.app.classList.toggle('phase-result', isResult);
    this.elements.prepGuide.classList.toggle('hidden', !isPrep);
    this.elements.battleGuide.classList.toggle('hidden', !isBattle);
    this.elements.deployedCount.textContent = String(isPrep ? this.deployments.length : this.simulation?.playerCount ?? 0);
    const playerCount = isPrep ? this.deployments.length : this.simulation?.playerCount ?? 0;
    const enemyCount = isPrep ? this.enemyPreviewUnits.length : this.simulation?.enemyCount ?? 0;
    this.elements.playerCount.textContent = String(playerCount);
    this.elements.enemyCount.textContent = String(enemyCount);
    const total = playerCount + enemyCount;
    this.elements.battleProgress.style.width = `${total ? Math.round((playerCount / total) * 100) : 0}%`;
    const waveCount = this.simulation?.totalWaves ?? this.level.waves?.length ?? 1;
    const waveNumber = this.simulation ? Math.min(this.simulation.waveIndex + 1, waveCount) : 0;
    this.elements.waveReadout.textContent = isPrep ? `共 ${waveCount} 波` : `第 ${waveNumber} / ${waveCount} 波`;
    this.elements.battleClock.textContent = formatClock(this.simulation?.time ?? 0);
    this.elements.speedReadout.textContent = `${this.speed}×${this.slowInput ? ' · 慢' : ''}`;
    this.updateUnitCards();
    if (isResult) this.elements.resultOverlay.classList.remove('hidden');
  }

  updateUnitCards() {
    for (const card of this.elements.unitList.children) {
      const unit = this.unitsById[card.dataset.unitId];
      card.classList.toggle('selected', this.phase === 'prep' && this.selectedUnitId === unit.id);
      card.classList.toggle('disabled', this.phase !== 'prep' || this.budgetRemaining < unit.price);
      const mark = card.querySelector('.selected-mark');
      if (this.phase === 'prep' && this.selectedUnitId === unit.id) {
        if (!mark) card.append(makeElement('span', 'selected-mark', '●'));
      } else if (mark) {
        mark.remove();
      }
    }
  }

  frame(now) {
    const elapsed = this.lastFrameTime ? Math.min(0.05, (now - this.lastFrameTime) / 1000) : 0;
    this.lastFrameTime = now;
    this.renderTime += elapsed;
    if (this.phase === 'battle' && this.simulation && !this.paused) {
      const timeScale = this.slowInput ? 0.2 : this.speed;
      this.simulation.update(elapsed * timeScale);
      this.finishBattle();
      this.syncUi();
    }
    this.render();
    window.requestAnimationFrame((time) => this.frame(time));
  }

  render() {
    if (!this.renderer) return;
    this.clampCamera();
    this.renderer.begin(this.camera);
    this.drawArena();
    this.drawUnitsAndEffects();
    this.renderer.end();
    this.updateWorldLabels();
  }

  drawArena() {
    const renderer = this.renderer;
    renderer.drawRect(WORLD.width / 2, WORLD.height / 2, WORLD.width, WORLD.height, '#102832');
    renderer.drawRect(400, WORLD.height / 2, 720, 700, '#173b3b', 0.72);
    renderer.drawRect(1200, WORLD.height / 2, 720, 700, '#3a2632', 0.66);
    renderer.drawRect(WORLD.width / 2, WORLD.height / 2, 86, 700, '#133c4b', 0.9);
    renderer.drawLine(800, WORLD.minY, 800, WORLD.maxY, 2, '#63e0cb', 0.22);

    for (let x = 40; x <= WORLD.width - 40; x += 80) renderer.drawLine(x, WORLD.minY, x, WORLD.maxY, 1, '#91c6bb', 0.08);
    for (let y = 40; y <= WORLD.height - 40; y += 80) renderer.drawLine(WORLD.minX, y, WORLD.maxX, y, 1, '#91c6bb', 0.08);
    renderer.drawLine(WORLD.minX, WORLD.minY, WORLD.maxX, WORLD.minY, 3, '#a5dbd0', 0.2);
    renderer.drawLine(WORLD.maxX, WORLD.minY, WORLD.maxX, WORLD.maxY, 3, '#a5dbd0', 0.2);
    renderer.drawLine(WORLD.maxX, WORLD.maxY, WORLD.minX, WORLD.maxY, 3, '#a5dbd0', 0.2);
    renderer.drawLine(WORLD.minX, WORLD.maxY, WORLD.minX, WORLD.minY, 3, '#a5dbd0', 0.2);
    renderer.drawLine(PLAYER_ZONE_RIGHT, WORLD.minY + 6, PLAYER_ZONE_RIGHT, WORLD.maxY - 6, 2, '#63e0cb', 0.15);
    renderer.drawLine(840, WORLD.minY + 6, 840, WORLD.maxY - 6, 2, '#ff796a', 0.12);

    if (this.phase === 'prep' && this.selectedUnitId) {
      const unit = this.unitsById[this.selectedUnitId];
      if (this.hoverWorld && this.isValidPlacement(this.hoverWorld.x, this.hoverWorld.y, unit)) {
        renderer.drawCircle(this.hoverWorld.x, this.hoverWorld.y, unit.radius, unit.color, 24, 0.28);
        renderer.drawRing(this.hoverWorld.x, this.hoverWorld.y, unit.radius + 6, 3, '#63e0cb', 24, 0.8);
      }
    }
  }

  isValidPlacement(x, y, unit) {
    return Boolean(unit) && x >= WORLD.minX + PLAYER_SAFE_MARGIN && x <= PLAYER_ZONE_RIGHT - unit.radius && y >= WORLD.minY + PLAYER_SAFE_MARGIN && y <= WORLD.maxY - PLAYER_SAFE_MARGIN && this.budgetRemaining >= unit.price;
  }

  drawUnitsAndEffects() {
    const units = this.battleUnits;
    for (const unit of units) {
      if (!unit.data) continue;
      this.drawUnit(unit);
    }
    if (!this.simulation || this.phase === 'prep') return;
    for (const projectile of this.simulation.projectiles) {
      this.renderer.drawLine(projectile.x - 8, projectile.y - 8, projectile.x + 8, projectile.y + 8, 4, projectile.color, 0.88);
      this.renderer.drawCircle(projectile.x, projectile.y, 5, projectile.color, 12, 0.95);
    }
    for (const effect of this.simulation.effects) {
      const progress = clamp(effect.life / Math.max(0.01, effect.duration), 0, 1);
      const radius = effect.radius * (1.08 - progress * 0.2);
      if (effect.type === 'death') {
        this.renderer.drawRing(effect.x, effect.y, radius * (1.5 - progress * 0.4), 7, effect.color, 28, progress * 0.66);
        this.renderer.drawCircle(effect.x, effect.y, radius * 0.5 * progress, effect.color, 20, progress * 0.22);
      } else if (effect.type === 'heal') {
        this.renderer.drawRing(effect.x, effect.y, radius, 5, '#9cf6a6', 28, progress * 0.85);
        this.renderer.drawLine(effect.x - radius * 0.35, effect.y, effect.x + radius * 0.35, effect.y, 4, '#9cf6a6', progress);
        this.renderer.drawLine(effect.x, effect.y - radius * 0.35, effect.x, effect.y + radius * 0.35, 4, '#9cf6a6', progress);
      } else if (effect.type === 'mark') {
        this.renderer.drawRing(effect.x, effect.y, radius, 3, effect.color, 20, progress * 0.85);
      } else {
        this.renderer.drawRing(effect.x, effect.y, radius, 5, effect.color, 28, progress * 0.8);
        this.renderer.drawCircle(effect.x, effect.y, Math.max(2, radius * 0.22), effect.color, 20, progress * 0.12);
      }
    }
  }

  drawUnit(unit) {
    const data = unit.data;
    const alive = unit.alive !== false;
    const deathProgress = alive ? 1 : clamp(1 - (unit.deadFor ?? 0) / 3, 0, 1);
    if (deathProgress <= 0) return;
    const radius = data.radius * (alive ? 1 : 0.78);
    const factionColor = unit.side === 'player' ? '#63e0cb' : '#ff796a';
    const isSelected = this.phase === 'prep' && this.selectedUnitId === data.id;
    const pulse = alive && unit.pulse > 0 ? 1 + Math.sin(this.renderTime * 36) * 0.08 : 1;
    const drawRadius = radius * pulse;

    this.renderer.drawCircle(unit.x + 5, unit.y + 7, drawRadius + 3, '#030b12', 24, 0.34 * deathProgress);
    if (this.renderer.spriteReady && Number.isInteger(data.spriteIndex)) {
      const spriteSize = Math.max(data.radius * 3.0, 70) * (alive ? pulse : 0.9);
      this.renderer.drawCircle(unit.x, unit.y, Math.max(5, drawRadius * 0.52), data.accent, 20, deathProgress * 0.2);
      this.renderer.drawSprite(unit.x, unit.y - data.radius * 0.22, spriteSize, spriteSize, data.spriteIndex, (alive ? 0.98 : 0.44) * deathProgress, '#ffffff', unit.side === 'enemy');
    } else {
      this.renderer.drawCircle(unit.x, unit.y, drawRadius, data.color, 24, (alive ? 0.94 : 0.42) * deathProgress);
    }
    this.renderer.drawRing(unit.x, unit.y, drawRadius + 4, isSelected ? 5 : 3, isSelected ? '#f4c66a' : factionColor, 24, deathProgress * 0.9);
    if (!this.renderer.spriteReady || !Number.isInteger(data.spriteIndex)) {
      this.renderer.drawCircle(unit.x, unit.y, Math.max(4, drawRadius * 0.28), data.accent, 16, deathProgress * 0.9);
    }

    if (alive) {
      const facing = Number.isFinite(unit.facing) ? unit.facing : (unit.side === 'player' ? 0 : Math.PI);
      this.renderer.drawLine(unit.x, unit.y, unit.x + Math.cos(facing) * (drawRadius + 10), unit.y + Math.sin(facing) * (drawRadius + 10), 3, data.accent, 0.75);
      const hpRatio = clamp((unit.hp ?? data.hp) / Math.max(1, unit.maxHp ?? data.hp), 0, 1);
      const barWidth = Math.max(34, drawRadius * 2.3);
      this.renderer.drawRect(unit.x, unit.y - drawRadius - 12, barWidth, 5, '#09151d', 0.88);
      this.renderer.drawRect(unit.x - (barWidth * (1 - hpRatio)) / 2, unit.y - drawRadius - 12, barWidth * hpRatio, 5, hpRatio > 0.35 ? factionColor : '#ffb06a', 0.94);
      if (unit.status?.stun > 0) this.renderer.drawRing(unit.x, unit.y, drawRadius + 10, 2, '#f4c66a', 14, 0.92);
      if (unit.status?.taunt > 0) this.renderer.drawRing(unit.x, unit.y, drawRadius + 13, 2, '#ff796a', 14, 0.8);
      if (unit.status?.guard > 0) this.renderer.drawRing(unit.x, unit.y, drawRadius + 9, 3, '#edf2f4', 24, 0.76);
    }
  }

  updateWorldLabels() {
    const visibleUnits = this.battleUnits;
    const activeIds = new Set();
    for (const unit of visibleUnits) {
      if (!unit.data || unit.alive === false && (unit.deadFor ?? 0) > 3) continue;
      const id = unit.id ?? `${unit.side}-${unit.data.id}-${unit.x}-${unit.y}`;
      activeIds.add(id);
      let label = this.labelNodes.get(id);
      if (!label) {
        label = makeElement('div', 'world-label');
        this.labelNodes.set(id, label);
        this.worldLabels.append(label);
      }
      const isRetreating = this.phase === 'battle' && unit.alive !== false && unit.intent === 'retreat';
      label.className = `world-label${unit.side === 'enemy' ? ' enemy' : ''}${isRetreating ? ' retreat' : ''}`;
      const hpText = this.phase === 'prep' ? '' : ` · ${Math.max(0, Math.ceil(unit.hp ?? 0))}`;
      label.textContent = `${unit.data.name}${isRetreating ? ' · 后撤' : ''}${hpText}`;
      const screen = this.renderer.worldToScreen(unit.x, unit.y - unit.data.radius - 30);
      label.style.left = `${screen.x}px`;
      label.style.top = `${screen.y}px`;
      label.style.opacity = this.isScreenVisible(screen.x, screen.y) ? String(unit.alive === false ? 0.35 : 1) : '0';
    }
    for (const [id, node] of this.labelNodes.entries()) {
      if (!activeIds.has(id)) {
        node.remove();
        this.labelNodes.delete(id);
      }
    }
  }

  isScreenVisible(x, y) {
    return x > -90 && y > -35 && x < this.renderer.width + 90 && y < this.renderer.height + 35;
  }
}

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`加载 ${path} 失败：${response.status}`);
  return response.json();
}

async function bootstrap() {
  try {
    const [unitsData, levelsData] = await Promise.all([loadJson('./data/units.json'), loadJson('./data/levels.json')]);
    const app = new MemeWarApp(unitsData, levelsData);
    await app.init();
    window.memeWarApp = app;
  } catch (error) {
    console.error(error);
    const loading = $('#loading');
    if (loading) {
      loading.querySelector('span').textContent = '战场数据加载失败，请确认通过本地服务器打开。';
    }
  }
}

bootstrap();
